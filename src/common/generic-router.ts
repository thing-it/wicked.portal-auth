'use strict';

import * as async from 'async';
import { AuthRequest, AuthResponse, EmailMissingHandler, ExpressHandler, IdentityProvider, TokenRequest, AccessTokenCallback, AccessToken } from './types';
import { profileStore } from './profile-store'
const { debug, info, warn, error } = require('portal-env').Logger('portal-auth:generic-router');
import * as wicked from 'wicked-sdk';
import * as request from 'request';

import { oauth2 } from '../kong-oauth2/oauth2';
import { tokens } from '../kong-oauth2/tokens';

const Router = require('express').Router;
const qs = require('querystring');

import { utils } from './utils';
import { kongUtils } from '../kong-oauth2/kong-utils';
import { utilsOAuth2 } from './utils-oauth2';
import { failMessage, failError, failOAuth, makeError, failJson } from './utils-fail';
import { OidcProfile, WickedApiScopes, WickedGrant, WickedUserInfo, WickedUserCreateInfo, WickedScopeGrant, WickedNamespace, WickedCollection, WickedRegistration, PassthroughScopeResponse, Callback, PassthroughScopeRequest } from 'wicked-sdk';
import { GrantManager } from './grant-manager';

const ERROR_TIMEOUT = 500; // ms
const EXTERNAL_URL_INTERVAL = 500;
const EXTERNAL_URL_RETRIES = 10;

export class GenericOAuth2Router {

    protected authMethodId: string;
    protected oauthRouter: any;
    protected idp: IdentityProvider;

    constructor(basePath: string, authMethodId: string) {
        debug(`constructor(${basePath}, ${authMethodId})`);
        this.oauthRouter = new Router();
        this.authMethodId = authMethodId;

        this.initOAuthRouter();
        const grantManager = new GrantManager(this.authMethodId);
        this.oauthRouter.use('/grants', grantManager.getRouter());
    }

    public getRouter() {
        return this.oauthRouter;
    };

    public initIdP(idp: IdentityProvider): void {
        debug(`initIdP(${idp.getType()})`);
        this.idp = idp;
        // Configure additional end points (if applicable). JavaScript is sick.
        const endpoints = idp.endpoints();
        const standardEndpoints = [
            {
                method: 'get',
                uri: '/verify/:verificationId',
                handler: this.createVerifyHandler(this.authMethodId)
            },
            {
                method: 'post',
                uri: '/verify',
                handler: this.createVerifyPostHandler(this.authMethodId)
            },
            {
                method: 'get',
                uri: '/verifyemail',
                handler: this.createVerifyEmailHandler(this.authMethodId)
            },
            {
                method: 'post',
                uri: '/verifyemail',
                handler: this.createVerifyEmailPostHandler(this.authMethodId)
            },
            {
                method: 'post',
                uri: '/grant',
                handler: this.createGrantPostHandler(this.authMethodId)
            },
            {
                method: 'post',
                uri: '/selectnamespace',
                handler: this.createSelectNamespacePostHandler(this.authMethodId)
            }
        ];
        // Spread operator, fwiw.
        endpoints.push(...standardEndpoints);
        for (let i = 0; i < endpoints.length; ++i) {
            const e = endpoints[i];
            if (!e.uri)
                throw new Error('initIdP: Invalid end point definition, "uri" is null): ' + JSON.stringify(e));
            if (!e.handler)
                throw new Error('initIdP: Invalid end point definition, "handler" is null): ' + JSON.stringify(e));
            if (e.middleware)
                this.oauthRouter[e.method](e.uri, e.middleware, e.handler);
            else
                this.oauthRouter[e.method](e.uri, e.handler);
        }

        const instance = this;
        // Specific error handler for this router
        this.oauthRouter.use(function (err, req, res, next) {
            debug(`Error handler for ${instance.authMethodId}`);
            // Handle OAuth2 errors specifically here
            if (err.oauthError) {
                if (req.isTokenFlow) {
                    // Return a plain error message in JSON
                    error(err);
                    const status = err.status || 500;
                    return res.status(status).json({ error: err.oauthError, error_description: err.message });
                }

                // Check for authorization calls
                if (utils.isLoggedIn(req, instance.authMethodId)) {
                    const sessionData = utils.getSession(req, instance.authMethodId);
                    // We need an auth request to see how to answer
                    if (sessionData.authRequest && sessionData.authRequest.redirect_uri) {
                        // We must create a redirect with the error message
                        const redirectUri = `${sessionData.authRequest.redirect_uri}?error=${qs.escape(err.oauthError)}&error_description=${qs.escape(err.message)}`;
                        return res.redirect(redirectUri);
                    }
                }
            }

            // Whatever has not been handled yet, delegate to generic error handler (app.ts)
            return next(err);
        });
    }

    public createVerifyHandler(authMethodId: string): ExpressHandler {
        debug(`createVerifyEmailHandler(${authMethodId})`);
        // GET /verify/:verificationId
        return (req, res, next) => {
            debug(`verifyEmailHandler(${authMethodId})`);
            const verificationId = req.params.verificationId;

            wicked.getVerification(verificationId, (err, verificationInfo) => {
                if (err && (err.statusCode === 404 || err.status === 404))
                    return setTimeout(failMessage, ERROR_TIMEOUT, 404, 'The given verification ID is not valid.', next);
                if (err)
                    return failError(500, err, next);
                if (!verificationInfo)
                    return setTimeout(failMessage, ERROR_TIMEOUT, 404, 'The given verification ID is not valid.', next);

                const viewModel = utils.createViewModel(req, authMethodId);
                viewModel.email = verificationInfo.email;
                viewModel.id = verificationId;

                switch (verificationInfo.type) {
                    case "email":
                        return utils.render(req, res, 'verify_email', viewModel);

                    case "lostpassword":
                        return utils.render(req, res, 'verify_password_reset', viewModel);

                    default:
                        return failMessage(500, `Unknown verification type ${verificationInfo.type}`, next);
                }
            });
        };
    }

    public createVerifyPostHandler(authMethodId): ExpressHandler {
        debug(`createVerifyPostHandler(${authMethodId})`);
        return function (req, res, next): void {
            debug(`verifyPostHandler(${authMethodId})`);

            const body = req.body;
            const expectedCsrfToken = utils.getAndDeleteCsrfToken(req);
            const csrfToken = body._csrf;
            const verificationId = body.verification_id;
            const verificationType = body.type;

            if (!csrfToken || expectedCsrfToken !== csrfToken) {
                setTimeout(failMessage, ERROR_TIMEOUT, 403, 'CSRF validation failed.', next);
                return;
            }

            wicked.getVerification(verificationId, (err, verificationInfo) => {
                if (err && (err.statusCode === 404 || err.status === 404))
                    return setTimeout(failMessage, ERROR_TIMEOUT, 404, 'The given verification ID is not valid.', next);
                if (err)
                    return failError(500, err, next);
                if (!verificationInfo)
                    return setTimeout(failMessage, ERROR_TIMEOUT, 404, 'The given verification ID is not valid.', next);
                debug(`Successfully retrieved verification info for user ${verificationInfo.userId} (${verificationInfo.email})`);

                if (verificationType !== verificationInfo.type)
                    return failMessage(500, 'Verification information found, does not match form data (type)', next);
                switch (verificationType) {
                    case "email":
                        // We're fine, we can verify the user's email address via the wicked API (as the machine user)
                        wicked.apiPatch(`/users/${verificationInfo.userId}`, { validated: true }, null, (err, userInfo) => {
                            if (err)
                                return setTimeout(failError, ERROR_TIMEOUT, 500, err, next);
                            info(`Successfully patched user, validated email for user ${verificationInfo.userId} (${verificationInfo.email})`);

                            // Pop off a deletion of the verification, but don't wait for it.
                            wicked.apiDelete(`/verifications/${verificationId}`, null, (err) => { if (err) error(err); });

                            // Success
                            const viewModel = utils.createViewModel(req, authMethodId);
                            return utils.render(req, res, 'verify_email_post', viewModel);
                        });
                        break;
                    case "lostpassword":
                        const password = body.password;
                        const password2 = body.password2;
                        if (!password || !password2 || password !== password2 || password.length > 25 || password.length < 6)
                            return failMessage(400, 'Invalid passwords/passwords do not match.', next);
                        // OK, let's give this a try
                        wicked.apiPatch(`/users/${verificationInfo.userId}`, { password: password }, null, (err, userInfo) => {
                            if (err)
                                return setTimeout(failError, ERROR_TIMEOUT, 500, err, next);

                            info(`Successfully patched user, changed password for user ${verificationInfo.userId} (${verificationInfo.email})`);

                            // Pop off a deletion of the verification, but don't wait for it.
                            wicked.apiDelete(`/verifications/${verificationId}`, null, (err) => { if (err) error(err); });

                            // Success
                            const viewModel = utils.createViewModel(req, authMethodId);
                            return utils.render(req, res, 'verify_password_reset_post', viewModel);
                        });
                        break;

                    default:
                        return setTimeout(failMessage, ERROR_TIMEOUT, 500, `Unknown verification type ${verificationType}`, next);
                }
            });
        };
    };

    public createForgotPasswordHandler(authMethodId): ExpressHandler {
        debug(`createForgotPasswordHandler(${authMethodId})`);
        return (req, res, next) => {
            debug(`forgotPasswordHandler(${authMethodId})`);

            const viewModel = utils.createViewModel(req, authMethodId);
            return utils.render(req, res, 'forgot_password', viewModel);
        };
    }

    public createForgotPasswordPostHandler(authMethodId): ExpressHandler {
        debug(`createForgotPasswordPostHandler(${authMethodId})`);
        return function (req, res, next): void {
            debug(`forgotPasswordPostHandler(${authMethodId})`);

            const body = req.body;
            const expectedCsrfToken = utils.getAndDeleteCsrfToken(req);
            const csrfToken = body._csrf;
            const email = body.email;

            if (!csrfToken || expectedCsrfToken !== csrfToken) {
                setTimeout(failMessage, ERROR_TIMEOUT, 403, 'CSRF validation failed.', next);
                return;
            }
            let emailValid = /.+@.+/.test(email);
            if (emailValid) {
                // Try to retrieve the user from the database
                wicked.getUserByEmail(email, (err, userInfoList) => {
                    if (err)
                        return error(err);
                    if (!Array.isArray(userInfoList))
                        return warn('forgotPasswordPostHandler: GET users by email did not return an array');
                    if (userInfoList.length !== 1)
                        return warn(`forgotPasswordPostHandler: GET users by email returned a list of length ${userInfoList.length}, expected length 1`);
                    // OK, we have exactly one user
                    const userInfo = userInfoList[0];
                    info(`Issuing password reset request for user ${userInfo.id} (${userInfo.email})`);

                    // Fire off the verification/password reset request creation (the mailer will take care
                    // of actually sending the emails).
                    const authUrl = utils.getExternalUrl();
                    const resetLink = `${authUrl}/${authMethodId}/verify/{{id}}`;

                    const verifInfo = {
                        type: 'lostpassword',
                        email: userInfo.email,
                        userId: userInfo.id,
                        link: resetLink
                    };
                    wicked.apiPost('/verifications', verifInfo, null, (err) => {
                        if (err)
                            return error(err);
                        debug(`SUCCESS: Issuing password reset request for user ${userInfo.id} (${userInfo.email})`);
                    });
                });
            }

            // No matter what happens, we will send the same page to the user.
            const viewModel = utils.createViewModel(req, authMethodId);
            utils.render(req, res, 'forgot_password_post', viewModel);
        };
    }

    public createVerifyEmailHandler(authMethodId): ExpressHandler {
        debug(`createVerifyEmailHandler(${authMethodId})`);
        return (req, res, next) => {
            debug(`verifyEmailHandler(${authMethodId})`);

            // Steps:
            // 1. Verify that the user is logged in
            // 2. Display a small form
            // 3. Let user click a button and we will send an email (via portal-mailer)

            if (!utils.isLoggedIn(req, authMethodId)) {
                // User is not logged in; make sure we do that first
                return utils.loginAndRedirectBack(req, res, authMethodId);
            }
            // const redirectUri = `${req.app.get('base_url')}${authMethodId}/verifyemail`;

            debug(`verifyEmailHandler(${authMethodId}): User is correctly logged in.`);

            const viewModel = utils.createViewModel(req, authMethodId);
            viewModel.profile = utils.getAuthResponse(req, authMethodId).profile;

            return utils.render(req, res, 'verify_email_request', viewModel);
        };
    };

    createVerifyEmailPostHandler(authMethodId): ExpressHandler {
        debug(`createVerifyEmailPostHandler(${authMethodId})`);
        return (req, res, next) => {
            debug(`verifyEmailPostHandler(${authMethodId})`);

            const body = req.body;
            const expectedCsrfToken = utils.getAndDeleteCsrfToken(req);
            const csrfToken = body._csrf;

            if (!utils.isLoggedIn(req, authMethodId))
                return failMessage(403, 'You must be logged in to request email validation.', next);
            if (!csrfToken || expectedCsrfToken !== csrfToken)
                return setTimeout(failMessage, ERROR_TIMEOUT, 403, 'CSRF validation failed.', next);

            const profile = utils.getProfile(req, authMethodId);
            const email = profile.email;

            // If we're here, the user is not trusted (as we're asking for a validation)
            const trustUsers = false;
            utils.createVerificationRequest(trustUsers, authMethodId, email, (err) => {
                if (err)
                    return failError(500, err, next);
                return utils.render(req, res, 'verify_email_request_confirm', utils.createViewModel(req, authMethodId));
            });
        };
    }

    createEmailMissingHandler(authMethodId, continueAuthenticate): EmailMissingHandler {
        debug(`createEmailMissingHandler(${authMethodId})`);
        return (req, res, next, customId) => {
            debug(`emailMissingHandler(${authMethodId})`);

            utils.getUserByCustomId(customId, (err, userInfo) => {
                if (err)
                    return failError(500, err, next);
                // Known user, and known email address?
                if (userInfo && userInfo.email)
                    return continueAuthenticate(req, res, next, userInfo.email);
                // Unknown user, ask for email please            
                const viewModel = utils.createViewModel(req, authMethodId);
                return utils.render(req, res, 'email_missing', viewModel);
            });
        };
    }

    createEmailMissingPostHandler(authMethodId, continueAuthenticate) {
        debug(`createEmailMissingPostHandler(${authMethodId})`);
        return (req, res, next): void => {
            debug(`emailMissingPostHandler(${authMethodId})`);

            const body = req.body;
            const expectedCsrfToken = utils.getAndDeleteCsrfToken(req);
            const csrfToken = body._csrf;

            if (!csrfToken || expectedCsrfToken !== csrfToken) {
                setTimeout(failMessage, ERROR_TIMEOUT, 403, 'CSRF validation failed.', next);
                return;
            }

            const email = body.email;
            const email2 = body.email2;

            if (!email || !email2) {
                setTimeout(failMessage, ERROR_TIMEOUT, 400, 'Email address or confirmation not passed in.', next);
                return;
            }
            if (email !== email2) {
                setTimeout(failMessage, ERROR_TIMEOUT, 400, 'Email address and confirmation of email address do not match', next);
                return;
            }

            // Pass back email address to calling IdP (e.g. Twitter)
            return continueAuthenticate(req, res, next, email);
        };
    }

    private initAuthRequest(req): AuthRequest {
        debug(`initAuthRequest(${this.authMethodId})`);
        if (!req.session)
            req.session = {};
        if (!req.session[this.authMethodId])
            req.session[this.authMethodId] = { authRequest: {} };
        else // Reset the authRequest even if it's present
            req.session[this.authMethodId].authRequest = {};
        const authRequest = req.session[this.authMethodId].authRequest;
        return authRequest;
    };

    private initOAuthRouter() {
        debug(`initOAuthRouter(${this.authMethodId})`);

        const instance = this;

        // OAuth2 end point Authorize
        this.oauthRouter.get('/api/:apiId/authorize', /*csrfProtection,*/ function (req, res, next) {
            const apiId = req.params.apiId;
            debug(`/${instance.authMethodId}/api/${apiId}/authorize`);

            const clientId = req.query.client_id;
            const responseType = req.query.response_type;
            const givenRedirectUri = req.query.redirect_uri;
            const givenState = req.query.state;
            const givenScope = req.query.scope;
            const givenPrompt = req.query.prompt;
            // This is not OAuth2 compliant, but needed
            const givenNamespace = req.query.namespace;

            const authRequest = instance.initAuthRequest(req);
            authRequest.api_id = apiId;
            authRequest.client_id = clientId;
            authRequest.response_type = responseType;
            authRequest.redirect_uri = givenRedirectUri;
            authRequest.state = givenState;
            authRequest.scope = givenScope;
            authRequest.prompt = givenPrompt;
            authRequest.namespace = givenNamespace;

            // Validate parameters first now (TODO: This is pbly feasible centrally,
            // it will be the same for all Auth Methods).
            utilsOAuth2.validateAuthorizeRequest(authRequest, function (err, validationResult) {
                if (err) {
                    return next(err);
                }

                // Is it a trusted application?
                authRequest.trusted = validationResult.trusted;

                utilsOAuth2.validateApiScopes(
                    authRequest.api_id,
                    authRequest.scope,
                    authRequest.trusted,
                    (err, scopeValidationResult) => {
                        if (err)
                            return next(err);

                        // Rewrite the scope to an array which resulted from the validation.
                        // Note that this is not the granted scopes, but the scopes that this
                        // application requests, and we have (only) validated that the scopes
                        // are present. If the application is not trusted, it may be that we
                        // will ask the user to grant the scope rights to the application later
                        // on.
                        authRequest.scope = scopeValidationResult.validatedScopes;
                        // Did we add/change the scopes passed in?
                        authRequest.scopesDiffer = scopeValidationResult.scopesDiffer;

                        let isLoggedIn = utils.isLoggedIn(req, instance.authMethodId);
                        // Borrowed from OpenID Connect, check for prompt request for implicit grant
                        // http://openid.net/specs/openid-connect-implicit-1_0.html#RequestParameters
                        if (authRequest.response_type === 'token') {
                            switch (authRequest.prompt) {
                                case 'none':
                                    if (!isLoggedIn)
                                        return failOAuth(401, 'login_required', 'user must be logged in interactively, cannot authorize without logged in user.', next);
                                    return instance.authorizeFlow(req, res, next);
                                case 'login':
                                    // Force login; wipe session data
                                    if (isLoggedIn) {
                                        delete req.session[instance.authMethodId].authResponse;
                                        isLoggedIn = false;
                                    }
                                    break;
                            }
                        }
                        // We're fine. Check for pre-existing sessions.
                        if (isLoggedIn) {
                            const authResponse = utils.getAuthResponse(req, instance.authMethodId);
                            return instance.continueAuthorizeFlow(req, res, next, authResponse);
                        }

                        // Not logged in, or forced login
                        return instance.idp.authorizeWithUi(req, res, next, authRequest);
                    });
            });
        });

        // !!!
        this.oauthRouter.post('/api/:apiId/token', function (req, res, next) {
            const apiId = req.params.apiId;
            debug(`${instance.authMethodId}/api/${apiId}/token`);
            // Full switch/case on things to do, for all flows
            // - Client Credentials -> Go to Kong and get a token
            // - Authorization Code -> Go to Kong and get a token
            // - Resource Owner Password Grant --> Check username/password/client id/secret and get a token
            // - Refresh Token --> Check validity of user and client --> Get a token

            // Remember in the request that we're in the token flow; this is needed in the
            // error handler to make sure we return a valid OAuth2 error JSON, in case
            // we encounter errors.
            req.isTokenFlow = true;

            const tokenRequest = utilsOAuth2.makeTokenRequest(req, apiId, instance.authMethodId);
            utilsOAuth2.validateTokenRequest(tokenRequest, function (err) {
                if (err)
                    return next(err);
                // Ok, we know we have something which could work (all data)
                const handleTokenResult = function (err, accessToken: AccessToken): void {
                    if (err)
                        return failError(400, err, next);
                    if (accessToken.error)
                        return failOAuth(400, accessToken.error, accessToken.error_description, next);
                    if (accessToken.session_data) {
                        profileStore.registerTokenOrCode(accessToken, tokenRequest.api_id, accessToken.session_data, (err) => {
                            if (err)
                                return failError(500, err, next);
                            delete accessToken.session_data;
                            return res.status(200).json(accessToken);
                        });
                    } else {
                        return res.status(200).json(accessToken);
                    }
                };

                switch (tokenRequest.grant_type) {
                    case 'client_credentials':
                        // This is generically available for most auth methods
                        return utilsOAuth2.tokenClientCredentials(tokenRequest, handleTokenResult);
                    case 'authorization_code':
                        // Use the generic version here as well
                        return utilsOAuth2.tokenAuthorizationCode(tokenRequest, handleTokenResult);
                    case 'password':
                        // This has to be done specifically
                        return instance.tokenPasswordGrant(tokenRequest, handleTokenResult);
                    case 'refresh_token':
                        // This as well
                        return instance.tokenRefreshToken(tokenRequest, handleTokenResult);
                }
                // This should not be possible
                return failOAuth(400, 'unsupported_grant_type', `invalid grant type ${tokenRequest.grant_type}`, next);
            });
        });

        this.oauthRouter.post('/register', (req, res, next) => {
            // ...
            debug(`/register`);

            // First, check the registration nonce
            const sessionData = utils.getSession(req, instance.authMethodId);
            const nonce = req.body.nonce;
            if (!nonce)
                return failMessage(400, 'Registration nonce missing.', next);
            if (nonce !== sessionData.registrationNonce)
                return failMessage(400, 'Registration nonce mismatch.', next);

            // OK, this looks fine.
            const userId = sessionData.authResponse.userId;
            const poolId = sessionData.authResponse.registrationPool;

            const regData = req.body;
            // The backend validates the data
            const authRequest = utils.getAuthRequest(req, instance.authMethodId);
            const namespace = authRequest.namespace;
            regData.namespace = namespace;

            wicked.apiPut(`/registrations/pools/${poolId}/users/${userId}`, req.body, null, function (err) {
                if (err)
                    return failError(500, err, next);

                // Go back to the registration flow now
                return instance.registrationFlow(poolId, req, res, next);
            });
        });

        /**
         * End point for interactive login without using the OAuth2 mechanisms; this
         * is used in cases where we need a logged in user, but there is none; e.g.
         * scope management, or verifying email addresses.
         * 
         * This end point displays the provider specific login page, and requires
         * a redirect URL to get back to (which must be internal to this application).
         * In short: Use this when you need to make sure that you have a logged in user
         * and just need to redirect back to a page when it's done.
         * 
         * Parameters: Query parameter "redirect_uri", which takes a relative path
         * to this application (including the base_path).
         */
        this.oauthRouter.get('/login', function (req, res, next) {
            debug('GET /login - internal login');

            // Verify parameters
            const redirectUri = req.query.redirect_uri;
            if (!redirectUri)
                return failMessage(400, 'Missing redirect_uri query parameter.', next);

            // Are we already logged in?
            if (utils.isLoggedIn(req, instance.authMethodId)) {
                // Yup, let's just redirect
                return res.redirect(redirectUri);
            }

            // We're not yet logged in; let's do that now

            // Remember we're in a "special mode", so let's create a special type
            // of authRequest. The authRequest goes into the session.
            const authRequest = instance.initAuthRequest(req);
            authRequest.plain = true;
            authRequest.redirect_uri = redirectUri;

            return instance.idp.authorizeWithUi(req, res, next, authRequest);
        });
    }

    public continueAuthorizeFlow(req, res, next, authResponse: AuthResponse): void {
        debug('continueAuthorizeFlow()');
        // This is what happens here:
        //
        // 1. Check if user already exists if only customId is filled
        // 2. (If not) Possibly create user in local database  
        //     --> Note that if the local IdP does not want this, it
        //         must not call continueAuthorizeFlow before the user
        //         has actually been created (via a signup form).
        // 3. Check registration status
        // 4. If not registered, and registration is needed, display 
        //    registration form (for the API's registration pool)
        // 5. Check granted scopes, if not a trusted application is calling
        // 6. Call authorizeFlow

        // Extra TODO:
        // - Pass-through APIs do not create local users
        const instance = this;
        const authRequest = utils.getAuthRequest(req, instance.authMethodId);
        this.checkUserFromAuthResponse(authResponse, authRequest.api_id, (err, authResponse) => {
            if (err)
                return failError(500, err, next);

            const authRequest = utils.getAuthRequest(req, instance.authMethodId);
            if (!authRequest)
                return failMessage(500, 'Invalid state: authRequest is missing.', next);

            // Check for plain login mode (where there is no API involved)
            if (authRequest.plain) {
                if (!authRequest.redirect_uri)
                    return failMessage(500, 'Invalid state: authRequest.redirect_uri is missing.', next);
                // In this case, we don't need to check for any registrations; this is actually
                // not possible here, as there is no API to check with. We'll just continue with
                // redirecting to the redirect_uri in the authRequest (see GET /login).
                utils.setAuthResponse(req, instance.authMethodId, authResponse);

                debug(`continueAuthorizeFlow(${instance.authMethodId}): Doing plain login/redirecting: ${authRequest.redirect_uri}`);
                return res.redirect(authRequest.redirect_uri);
            }

            // Regular mode, we have an API we want to check registration state for.
            if (!authRequest.api_id)
                return failMessage(500, 'Invalid state: API in authorization request is missing.', next);

            const apiId = authRequest.api_id;
            utils.setAuthResponse(req, instance.authMethodId, authResponse);

            debug('Retrieving registration info...');
            // We have an identity now, do we need registrations?
            utils.getApiRegistrationPool(apiId, (err, poolId) => {
                if (err)
                    return failError(500, err, next);

                debug(authResponse);

                if (!poolId) {
                    if (authResponse.registrationPool)
                        delete authResponse.registrationPool;
                    // Nope, just go ahead; use the default Profile as profile, but using the ID from wicked
                    authResponse.profile = utils.clone(authResponse.defaultProfile) as OidcProfile;
                    // If we have a userId, use it as sub, otherwise keep the sub (passthroughUsers mode)
                    if (authResponse.userId)
                        authResponse.profile.sub = authResponse.userId;
                    return instance.authorizeFlow(req, res, next);
                }

                authResponse.registrationPool = poolId;
                debug(`API requires registration with pool '${poolId}', starting registration flow`);

                // We'll do the registrationFlow first then...
                return instance.registrationFlow(poolId, req, res, next);
            });
        });
    }


    // =============================================
    // Helper methods
    // =============================================

    private registrationFlow(poolId: string, req, res, next): void {
        debug('registrationFlow()');

        const authResponse = utils.getAuthResponse(req, this.authMethodId);
        const userId = authResponse.userId;

        const authRequest = utils.getAuthRequest(req, this.authMethodId);
        // This is not necessarily filled yet, but might be in a second run of this flow:
        const namespace = authRequest.namespace;
        const instance = this;
        utils.getPoolInfoByApi(authRequest.api_id, function (err, poolInfo) {
            if (err)
                return failError(500, err, next);

            const requiresNamespace = !!poolInfo.requiresNamespace;

            wicked.getUserRegistrations(poolId, userId, (err, regInfos) => {
                if (err && err.statusCode !== 404)
                    return failError(500, err, next);
                let regInfo;
                if (regInfos) {
                    if (namespace) {
                        regInfo = regInfos.items.find(r => r.namespace === namespace);
                    } else {
                        if (requiresNamespace) {
                            if (regInfos.items.length === 0)
                                return failMessage(400, 'Invalid request. For registering, a namespace must be given to enable registration (&namespace=...).', next);
                            if (regInfos.items.length === 1) {
                                // We want to return the namespace as well
                                regInfo = regInfos.items[0];
                                authRequest.namespace = regInfo.namespace;
                            } else {
                                return instance.renderSelectNamespace(req, res, next, regInfos);
                            }
                        } else {
                            // This pool does not require namespaces (and does not allow them)
                            if (regInfos.items.length > 0) {
                                if (regInfos.items.length !== 1)
                                    return failMessage(500, 'Multiple registrations detected for registration pool.', next);
                                regInfo = regInfos.items[0];
                            }
                        }
                    }
                }

                if (!regInfo) {
                    if (poolInfo.disableRegister) {
                        return failMessage(403, 'Registration is not allowed, only pre-registered users can access this API.', next);
                    }
                    // User does not have a registration here, we need to get one
                    return instance.renderRegister(req, res, next);
                } else {
                    // User already has a registration, create a suitable profile
                    // TODO: Here we could check for not filled required fields
                    utilsOAuth2.makeOidcProfile(poolId, authResponse, regInfo, (err, profile) => {
                        if (err)
                            return failError(500, err, next);
                        // This will override the default user profile which is already
                        // present, but that is fine.
                        authResponse.profile = profile;
                        return instance.authorizeFlow(req, res, next);
                    });
                }
            });
        });
    }

    private renderSelectNamespace(req, res, next, regInfos: WickedCollection<WickedRegistration>) {
        debug(`renderSelectNamespace()`);

        const instance = this;
        debug(regInfos);
        async.map(regInfos.items, (ri, callback) => {
            debug(ri);
            wicked.getPoolNamespace(ri.poolId, ri.namespace, (err, namespaceInfo) => {
                if (err && err.statusCode !== 404)
                    return callback(err);
                if (err && err.statusCode === 404)
                    return callback(null, null);
                return callback(null, namespaceInfo);
            });
        }, (err, results: WickedNamespace[]) => {
            if (err)
                return failError(500, err, next);
            const viewModel = utils.createViewModel(req, instance.authMethodId);
            debug(results);
            const tmpNs = [];
            for (let i = 0; i < results.length; ++i) {
                if (results[i])
                    tmpNs.push(results[i]);
            }
            viewModel.namespaces = tmpNs;

            // Note down which namespaces are valid
            const namespaceList = tmpNs.map(ni => ni.namespace);
            debug(namespaceList);
            const authRequest = utils.getAuthRequest(req, instance.authMethodId);
            authRequest.validNamespaces = namespaceList;

            return utils.render(req, res, 'select_namespace', viewModel, authRequest);
        });
    }

    private createSelectNamespacePostHandler(authMethodId: string): ExpressHandler {
        const instance = this;
        return function (req, res, next) {
            debug(`selectNamespacePostHandler(${authMethodId})`);
            const body = req.body;
            debug(body);
            const expectedCsrfToken = utils.getAndDeleteCsrfToken(req);
            const csrfToken = body._csrf;

            if (!csrfToken || expectedCsrfToken !== csrfToken) {
                setTimeout(failMessage, ERROR_TIMEOUT, 403, 'CSRF validation failed.', next);
                return;
            }

            const authRequest = utils.getAuthRequest(req, authMethodId);
            if (!authRequest.validNamespaces)
                return failMessage(403, 'Invalid state; missing list of valid namespaces.', next);
            const validNamespaces = authRequest.validNamespaces;
            delete authRequest.validNamespaces;

            // Verify that the selected namespace is actually a valid one
            const namespace = body.namespace;
            if (validNamespaces.findIndex(ns => ns === namespace) < 0)
                return failMessage(400, 'Invalid namespace selected. This should not be possible.', next);

            authRequest.namespace = namespace;
            // And off you go with the registration flow again...
            utils.getApiRegistrationPool(authRequest.api_id, (err, poolId) => {
                if (err)
                    return failError(500, err, next);
                return instance.registrationFlow(poolId, req, res, next);
            });
        };
    }

    private renderRegister(req, res, next) {
        debug('renderRegister()');

        const authResponse = utils.getAuthResponse(req, this.authMethodId);
        const authRequest = utils.getAuthRequest(req, this.authMethodId);
        const apiId = utils.getAuthRequest(req, this.authMethodId).api_id;
        debug(`API: ${apiId}`);

        utils.getPoolInfoByApi(apiId, (err, poolInfo) => {
            if (err)
                return failMessage(500, 'Invalid state, could not read API information for API ${apiId} to register for.', next);
            debug('Default profile:');
            debug(authResponse.defaultProfile);

            const viewModel = utils.createViewModel(req, this.authMethodId);
            viewModel.userId = authResponse.userId;
            viewModel.customId = authResponse.customId;
            viewModel.defaultProfile = authResponse.defaultProfile;
            viewModel.poolInfo = poolInfo;
            const nonce = utils.createRandomId();
            utils.getSession(req, this.authMethodId).registrationNonce = nonce;
            viewModel.nonce = nonce;

            debug(viewModel);
            utils.render(req, res, 'register', viewModel, authRequest);
        });
    }

    // This is called as soon as we are sure that we have a logged in user, and possibly
    // also a valid registration record (if applicable to the API). Now we also have to
    // check the scope of the authorization request, and possibly run the scopeFlow.
    private authorizeFlow(req, res, next): void {
        debug(`authorizeFlow(${this.authMethodId})`);
        const authRequest = utils.getAuthRequest(req, this.authMethodId);
        const authResponse = utils.getAuthResponse(req, this.authMethodId);

        // Check for passthrough Scope calculation
        const instance = this;
        utils.getApiInfo(authRequest.api_id, (err, apiInfo) => {
            if (err)
                return failError(500, err, next);

            if (authRequest.trusted || (authRequest.scope.length === 0 && !apiInfo.passthroughScopeUrl)) {
                // We have a trusted application, or an empty scope, we will not need to check for scope grants.
                return instance.authorizeFlow_Step2(req, res, next);
            }

            // Normal case: We don't have a passthroughScopeUrl, and thus we need to go through the scopeFlow
            if (!apiInfo.passthroughScopeUrl) {
                return instance.scopeFlow(req, res, next);
            }

            // OK, interesting, let's ask an upstream for the scope...
            instance.resolvePassthroughScope(authRequest.scope, authResponse.profile, apiInfo.passthroughScopeUrl, (err, scopeResponse: PassthroughScopeResponse) => {
                if (err)
                    return failError(500, err, next);
                if (!scopeResponse.allow) {
                    let msg = 'Scope validation with external system disallowed login (property "allow" is not present or not set to true)';
                    if (scopeResponse.error_message)
                        msg += `: ${scopeResponse.error_message}`;
                    return failMessage(403, msg, next);
                }

                if (scopeResponse.authenticated_scope)
                    authRequest.scope = scopeResponse.authenticated_scope;
                else
                    authRequest.scope = [];
                if (scopeResponse.authenticated_userid)
                    authResponse.profile.sub = scopeResponse.authenticated_userid;

                // And off we go
                return instance.authorizeFlow_Step2(req, res, next);
            });
        });
    }

    private resolvePassthroughScope(scope: any, profile: OidcProfile, url: string, callback: Callback<PassthroughScopeResponse>): void {
        debug(`resolvePassthroughScope()`);
        const scopeRequest: PassthroughScopeRequest = {
            scope: scope,
            profile: profile
        }
        async.retry({
            times: EXTERNAL_URL_RETRIES,
            interval: EXTERNAL_URL_INTERVAL
        }, function (callback) {
            debug(`resolvePassthroughScope: Attempting to get scope at ${url}`);
            request.post({
                url: url,
                body: scopeRequest,
                json: true,
                timeout: 5000
            }, (err, res, body) => {
                if (err)
                    return callback(err);
                if (res.statusCode < 200 || res.statusCode > 299)
                    return callback(makeError('Scope resolving via external service failed with unexpected status code.', res.statusCode));
                const scopeResponse = utils.getJson(body) as PassthroughScopeResponse;
                return callback(null, scopeResponse)
            });
        }, function (err, scopeResponse) {
            if (err)
                return callback(err);
            return callback(null, scopeResponse);
        });
    }

    // Here we validate the scope, check for whether the user has granted the scopes to the
    // application or not.
    private scopeFlow(req, res, next): void {
        debug(`scopeFlow(${this.authMethodId})`);

        const instance = this;

        const authRequest = utils.getAuthRequest(req, this.authMethodId);
        const authResponse = utils.getAuthResponse(req, this.authMethodId);

        const apiId = authRequest.api_id;
        const clientId = authRequest.client_id;
        const desiredScopesList = authRequest.scope; // ["scope1", "scope2",...]

        // If we're not in a passthrough situation, we have a userId here (and we're not,
        // that's checked in authorizeFlow).
        const userId = authResponse.userId;

        // Retrieve the application info for this client_id; the client_id is attached
        // to the subscription (glue between API, application and plan), but we get the
        // application back readily when asking for the subscription.
        debug(`Getting subscription for client_id ${clientId}`);
        wicked.getSubscriptionByClientId(clientId, apiId, (err, subsInfo) => {
            if (err)
                return failError(500, err, next);
            const appInfo = subsInfo.application;
            if (!appInfo)
                return failMessage(500, 'scopeFlow: Could not retrieve application info from client_id', next);
            debug(`Successfully retrieved subscription for client_id ${clientId}:`);
            debug(subsInfo);

            // Let's check whether the user already has some grants
            wicked.getUserGrant(userId, appInfo.id, apiId, (err, grantsInfo) => {
                if (err && err.status !== 404 && err.statusCode !== 404)
                    return failError(500, err, next); // Unexpected error
                if (err || !grantsInfo) {
                    // if err --> status 404
                    // Create a new grantsInfo object, it's not present
                    grantsInfo = {
                        grants: []
                    };
                }
                const grantsList = grantsInfo.grants;

                // Returns a list of scope names which need to be granted access to
                const missingGrants = instance.diffGrants(grantsList, desiredScopesList);

                if (missingGrants.length === 0) {
                    debug('All grants are already given; continue authorize flow.');
                    // We have all grants to scopes we need, we can continue
                    return instance.authorizeFlow_Step2(req, res, next);
                }
                debug('Missing grants:');
                debug(missingGrants);

                // We need additional scopes granted to the application; for that
                // we need to gather some information on the API (get the scope list).
                utils.getApiInfo(apiId, function (err, apiInfo) {
                    if (err)
                        return failError(500, err, next);
                    debug('Creating view model for grant scope form');

                    const viewModel = utils.createViewModel(req, instance.authMethodId);
                    viewModel.grantRequests = instance.makeScopeList(missingGrants, apiInfo.settings.scopes);
                    viewModel.apiInfo = apiInfo;
                    viewModel.appInfo = appInfo;

                    // Store some things for later reference
                    const sessionData = utils.getSession(req, instance.authMethodId);
                    sessionData.grantData = {
                        missingGrants: missingGrants,
                        existingGrants: grantsList
                    };

                    return utils.render(req, res, 'grant_scopes', viewModel, authRequest);
                });
            });
        });
    }

    private diffGrants(storedGrants: WickedScopeGrant[], desiredScopesList: string[]): string[] {
        debug('diffGrants()');
        const missingGrants = [];
        for (let i = 0; i < desiredScopesList.length; ++i) {
            const scope = desiredScopesList[i];
            let grantedScope = storedGrants.find(g => g.scope === scope);
            if (!grantedScope)
                missingGrants.push(scope);
        }
        return missingGrants;
    }

    private makeScopeList(grantNames: string[], apiScopes: WickedApiScopes): { scope: string, description: string }[] {
        const scopeList: { scope: string, description: string }[] = [];
        for (let i = 0; i < grantNames.length; ++i) {
            const grantName = grantNames[i];
            scopeList.push({
                scope: grantName,
                description: apiScopes[grantName].description
            });
        }
        return scopeList;
    }

    private createGrantPostHandler(authMethodId) {
        debug(`createGrantPostHandler(${authMethodId})`);
        const instance = this;
        return (req, res, next): void => {
            debug(`grantPostHandler(${authMethodId})`);
            const body = req.body;
            const expectedCsrfToken = utils.getAndDeleteCsrfToken(req);
            const csrfToken = body._csrf;
            const action = body._action;
            debug(`grantPostHandler(${authMethodId}, action: ${action})`);

            if (!csrfToken || expectedCsrfToken !== csrfToken) {
                setTimeout(failMessage, ERROR_TIMEOUT, 403, 'CSRF validation failed.', next);
                return;
            }

            if (!utils.isLoggedIn(req, authMethodId)) {
                setTimeout(failMessage, ERROR_TIMEOUT, 403, 'You are not logged in.', next);
                return;
            }

            const sessionData = utils.getSession(req, authMethodId);
            const grantData = sessionData.grantData;
            if (!grantData) {
                setTimeout(failMessage, ERROR_TIMEOUT, 500, 'Invalid state: Must contain grant data in session.', next);
                return;
            }
            const authRequest = sessionData.authRequest;
            const authResponse = sessionData.authResponse;
            if (!authRequest || !authResponse) {
                setTimeout(failMessage, ERROR_TIMEOUT, 500, 'Invalid state: Session must contain auth request and responses (you must be logged in)', next);
                return;
            }

            // Remove the grant data from the session
            delete sessionData.grantData;

            switch (action) {
                case "deny":
                    warn(`User ${authResponse.userId} denied access to API ${authRequest.api_id} for application ${authRequest.app_id}, failing.`);
                    failOAuth(403, 'access_denied', 'Access to the API was denied by the user', next);
                    return;

                case "allow":
                    info(`User ${authResponse.userId} granted access to API ${authRequest.api_id} for application ${authRequest.app_id}.`);
                    const grantList = grantData.existingGrants;
                    grantData.missingGrants.forEach(g => grantList.push({ scope: g }));
                    const userGrantInfo: WickedGrant = {
                        userId: authResponse.userId,
                        apiId: authRequest.api_id,
                        applicationId: authRequest.app_id,
                        grants: grantList
                    };
                    debug(userGrantInfo);
                    wicked.apiPut(`/grants/${authResponse.userId}/applications/${authRequest.app_id}/apis/${authRequest.api_id}`, userGrantInfo, null, function (err) {
                        if (err)
                            return failError(500, err, next);
                        info(`Successfully stored a grant for API ${authRequest.api_id} on behalf of user ${authResponse.userId}`);
                        // Now delegate back to the scopeFlow, we should be fine now.
                        return instance.scopeFlow(req, res, next);
                    });
                    return;
            }
            setTimeout(failMessage, ERROR_TIMEOUT, 500, 'Invalid action, must be "deny" or "allow".', next);
            return;
        };
    };

    private static mergeUserGroupScope(scope: any, groups: string[]): any {
        debug(`addUserGroupScope(${groups ? groups.toString() : '[]'})`);
        if (!groups)
            return scope;
        if (groups.length === 0)
            return scope;
        let returnScope = null;
        if (scope && typeof (scope) === 'string') {
            debug('scope is a string');
            returnScope = scope;
            if (!!returnScope)
                returnScope += ' ';
            let first = true;
            for (let i = 0; i < groups.length; ++i) {
                if (!first)
                    returnScope += ' ';
                returnScope += `wicked:${groups[i]}`;
                first = false;
            }
        } else if ((scope && Array.isArray(scope)) || !scope) {
            if (!scope)
                returnScope = [];
            else
                returnScope = scope;
            for (let i = 0; i < groups.length; ++i)
                returnScope.push(`wicked:${groups[i]}`);
        }
        return returnScope;
    }

    private makeAuthenticatedUserId(authRequest: AuthRequest, authResponse: AuthResponse) {
        debug(`makeAuthenticatedUserId()`);
        let authenticatedUserId = `sub=${authResponse.profile.sub}`;
        if (authRequest.namespace)
            authenticatedUserId += `;namespace=${authRequest.namespace}`;
        return authenticatedUserId;
    }

    private authorizeFlow_Step2(req, res, next): void {
        debug(`authorizeFlow_Step2(${this.authMethodId})`);
        const authRequest = utils.getAuthRequest(req, this.authMethodId);
        const authResponse = utils.getAuthResponse(req, this.authMethodId);
        const userProfile = authResponse.profile;
        debug('/authorize/login: Calling authorization end point.');
        debug(userProfile);
        oauth2.authorize({
            response_type: authRequest.response_type,
            authenticated_userid: this.makeAuthenticatedUserId(authRequest, authResponse),
            api_id: authRequest.api_id,
            client_id: authRequest.client_id,
            scope: GenericOAuth2Router.mergeUserGroupScope(authRequest.scope, authResponse.groups),
            auth_method: req.app.get('server_name') + ':' + this.authMethodId,
        }, function (err, redirectUri) {
            debug('/authorize/login: Authorization end point returned.');
            if (err)
                return failError(400, err, next);
            if (!redirectUri.redirect_uri)
                return failMessage(500, 'Server error, no redirect URI returned.', next);
            let uri = redirectUri.redirect_uri;
            // For this redirect_uri, which can contain either a code or an access token,
            // associate the profile (userInfo).
            profileStore.registerTokenOrCode(redirectUri, authRequest.api_id, userProfile, function (err) {
                if (err)
                    return failError(500, err, next);
                if (authRequest.state)
                    uri += '&state=' + qs.escape(authRequest.state);
                if (authRequest.namespace)
                    uri += '&namespace=' + qs.escape(authRequest.namespace);
                return res.redirect(uri);
            });
        });
    }

    private tokenPasswordGrant(tokenRequest: TokenRequest, callback: AccessTokenCallback): void {
        debug('tokenPasswordGrant()');
        const instance = this;
        // Let's validate the subscription first...
        utilsOAuth2.validateSubscription(tokenRequest, function (err, validationResult) {
            if (err)
                return callback(err);
            const trustedSubscription = validationResult.trusted;
            if (validationResult.subsInfo.application.confidential) {
                // Also check client_secret here
                if (!tokenRequest.client_secret)
                    return failOAuth(401, 'invalid_request', 'A confidential application must also pass its client_secret', callback);
                if (validationResult.subsInfo.subscription.clientSecret !== tokenRequest.client_secret)
                    return failOAuth(401, 'invalid_request', 'Invalid client secret', callback);
            }

            // Now we know whether we have a trusted subscription or not; only allow trusted subscriptions to
            // retrieve a token via the password grant.
            if (!trustedSubscription)
                return failOAuth(400, 'invalid_request', 'only trusted application subscriptions can retrieve tokens via the password grant.', callback);
            utilsOAuth2.validateApiScopes(tokenRequest.api_id, tokenRequest.scope, trustedSubscription, function (err, validatedScopes) {
                if (err)
                    return failOAuth(500, 'server_error', 'could not validate requested token scope', err, callback);
                // Update the scopes
                tokenRequest.scope = validatedScopes.validatedScopes;

                instance.idp.authorizeByUserPass(tokenRequest.username, tokenRequest.password, (err, authResponse) => {
                    if (err) {
                        // Don't answer wrong logins immediately please.
                        // TODO: The error message must be IdP specific, can be some other type
                        // of error than just wrong username or password.
                        setTimeout(() => {
                            return failOAuth(err.statusCode, 'invalid_request', 'invalid username or password', callback);
                        }, 500);
                        return;
                    }

                    // TODO: In the LDAP case, the ROPG may work even if the user has not logged
                    // in and thus does not yet have a user in the wicked database; this user has to
                    // be created on the fly here, and possibly also needs a registration done
                    // automatically, if the API needs a registration. If not, it's fine as is, but
                    // the user needs a dedicated wicked local user (with a "sub" == user id)
                    instance.checkUserFromAuthResponse(authResponse, tokenRequest.api_id, (err, authResponse) => {
                        if (err) {
                            // TODO: Rethink error messages and such.
                            setTimeout(() => {
                                return failOAuth(err.statusCode, 'invalid_request', 'could not unify auth response', callback);
                            }, 500);
                            return;
                        }
                        tokenRequest.scope = GenericOAuth2Router.mergeUserGroupScope(tokenRequest.scope, authResponse.groups);

                        // Now we want to check the registration status of this user with respect to
                        // the API; in case the API does not have a registration pool set, we're done.
                        // If it does, we have to distinguish the two cases "requires namespace" or
                        // "does not require namespace". In case there is no namespace required, the
                        // user *must* have a registration for the pool for this to succeed. In case
                        // the pool requires a namespace, the request will still succeed even if there
                        // aren't any registrations, but the list of associated namespaces is empty.
                        // The created authenticated_userid is also differing depending on the case.
                        utils.getApiInfo(tokenRequest.api_id, (err, apiInfo) => {
                            if (err) {
                                error(err);
                                return failOAuth(err.statusCode, 'server_error', 'could not retrieve API information', callback);
                            }

                            // Does this API have a registration pool at all?
                            if (!apiInfo.registrationPool) {
                                // No, this is fine. Now check if we can issue a token.
                                tokenRequest.authenticated_userid = `sub=${authResponse.userId}`;
                                tokenRequest.session_data = authResponse.profile;
                                return oauth2.token(tokenRequest, callback);
                            } else {
                                // OK, we have a registration pool, let's investigate further.
                                utils.getPoolInfo(apiInfo.registrationPool, (err, poolInfo) => {
                                    if (err)
                                        return failOAuth(err.statusCode, 'server_error', 'could not retrieve registration pool information', callback);
                                    // Then let's also retrieve the registrations for this user
                                    debug(`tokenPasswordGrant: Get user registrations for user ${authResponse.userId} and pool ${poolInfo.id}`)
                                    wicked.getUserRegistrations(poolInfo.id, authResponse.userId, (err, userRegs) => {
                                        if (err)
                                            return failOAuth(err.statusCode, 'server_error', 'could not retrieve user registrations', callback);
                                        // Case 1: No namespace required
                                        if (!poolInfo.requiresNamespace) {
                                            debug('tokenPasswordGrant: No namespace required, checking for registrations.');
                                            // Just check whether we have a registration
                                            if (userRegs.items.length <= 0) {
                                                // Naw, not good.
                                                return failOAuth(403, 'access_denied', 'accessing this API requires an existing user registration', callback);
                                            }
                                            // OK, we're fine.
                                            debug('tokenPasswordGrant: Success so far, issuing token.');
                                            tokenRequest.authenticated_userid = `sub=${authResponse.userId}`;
                                            tokenRequest.session_data = authResponse.profile;
                                            return oauth2.token(tokenRequest, callback);
                                        } else {
                                            // Case 2: Namespace required
                                            // Here we change the authenticated_userid slightly to carry both the sub and namespace information
                                            let authenticatedUserId = `sub=${authResponse.userId};namespaces=`;
                                            let first = true;
                                            for (let i = 0; i < userRegs.items.length; ++i) {
                                                if (!first)
                                                    authenticatedUserId += ',';
                                                authenticatedUserId += userRegs.items[i].namespace;
                                                first = false;
                                            }
                                            debug(`tokenPasswordGrant: Namespace required; authenticated_userid=${authenticatedUserId}`)
                                            debug('tokenPasswordGrant: Success so far, issuing token.');
                                            tokenRequest.authenticated_userid = authenticatedUserId;
                                            tokenRequest.session_data = authResponse.profile;
                                            return oauth2.token(tokenRequest, callback);
                                        }
                                    });
                                });
                            }
                        })
                    });
                });
            });
        });
    }

    private checkUserFromAuthResponse(authResponse: AuthResponse, apiId: string, callback: Callback<AuthResponse>): void {
        debug(`checkUserFromAuthResponse(..., ${apiId})`);
        const instance = this;
        utils.getApiInfo(apiId, (err, apiInfo) => {
            if (err)
                return callback(err);

            if (apiInfo.passthroughUsers) {
                // The API doesn't need persisted users, so we are done here now.
                debug(`checkUserFromAuthResponse: Passthrough API ${apiId}`);
                authResponse.userId = null;
                authResponse.groups = [];
                return callback(null, authResponse);
            }

            // The Auth response contains the default profile, which may or may not
            // match the stored profile in the wicked database. Plus that we might need to
            // create a federated user record in case we have a good valid 3rd party user,
            // which we want to track in the user database of wicked.
            function loadWickedUser(userId) {
                debug(`loadWickedUser(${userId})`);
                wicked.getUser(userId, (err, userInfo) => {
                    if (err)
                        return callback(err);
                    debug('loadUserAndProfile returned.');

                    // This just fills userId.
                    // The rest is done when handling the registrations (see
                    // registrationFlow()).
                    const oidcProfile = utilsOAuth2.wickedUserInfoToOidcProfile(userInfo) as OidcProfile;
                    authResponse.userId = userId;
                    authResponse.profile = oidcProfile;
                    authResponse.groups = userInfo.groups;

                    return callback(null, authResponse);
                });
            }

            if (authResponse.userId) {
                // We already have a wicked user id, load the user and fill the profile
                return loadWickedUser(authResponse.userId);
            } else if (authResponse.customId) {
                // Let's check the custom ID, load by custom ID
                utils.getUserByCustomId(authResponse.customId, (err, shortInfo) => {
                    if (err)
                        return callback(err);
                    if (!shortInfo) {
                        // Not found, we must create first
                        instance.createUserFromDefaultProfile(authResponse, (err, authResponse) => {
                            if (err)
                                return callback(err);
                            return loadWickedUser(authResponse.userId);
                        });
                    } else {
                        return loadWickedUser(shortInfo.id);
                    }
                });
            } else {
                return callback(new Error('checkUserFromAuthResponse: Neither customId nor userId was passed into authResponse.'));
            }
        });
    }

    // Takes an authResponse, returns an authResponse
    private createUserFromDefaultProfile(authResponse: AuthResponse, callback: Callback<AuthResponse>) {
        debug('createUserFromDefaultProfile()');
        const instance = this;
        // The defaultProfile MUST contain an email address.
        // The id of the new user is created by the API and returned here;
        // This is still an incognito user, name and such are amended later
        // in the process, via the registration.
        const userCreateInfo: WickedUserCreateInfo = {
            customId: authResponse.customId,
            email: authResponse.defaultProfile.email,
            validated: authResponse.defaultProfile.email_verified,
            groups: authResponse.defaultGroups
        };
        wicked.apiPost('/users', userCreateInfo, null, function (err, userInfo: WickedUserInfo) {
            if (err) {
                error('createUserFromDefaultProfile: POST to /users failed.');
                error(err);
                // Check if it's a 409, and if so, display a nicer error message.
                if (err.status === 409 || err.statusCode === 409)
                    return callback(makeError(`A user with the email address "${userCreateInfo.email}" already exists in the system. Please log in using the existing user's identity.`, 409));
                return callback(err);
            }
            debug(`createUserFromDefaultProfile: Created new user with id ${userInfo.id}`);
            authResponse.userId = userInfo.id;

            // Check whether we need to create a verification request, in case the email
            // address is not yet verified by the federated IdP (can happen with Twitter).
            // That we do asynchronously and return immediately without waiting for that.
            if (!userCreateInfo.validated) {
                info(`Creating email verification request for email ${userCreateInfo.email}...`);
                utils.createVerificationRequest(false, instance.authMethodId, userCreateInfo.email, (err) => {
                    if (err) {
                        error(`Creating email verification request for email ${userCreateInfo.email} failed`);
                        error(err);
                        return;
                    }
                    info(`Created email verification request for email ${userCreateInfo.email} successfully`);
                    return;
                });
            }

            return callback(null, authResponse);
        });
    }

    private static extractUserId(authUserId: string): string {
        if (!authUserId.startsWith('sub='))
            return authUserId;
        // Does it look like this: "sub=<user id>;namespace=<whatever>"
        const semicolonIndex = authUserId.indexOf(';');
        if (semicolonIndex < 0) {
            // We have only sub=<userid>, no namespace
            return authUserId.substring(4);
        }
        return authUserId.substring(4, semicolonIndex);
    }

    private static cleanupScopeString(scopes: string): string[] {
        debug(`cleanupScopeString(${scopes})`);
        if (!scopes)
            return [];
        const scopeList = scopes.split(' ');
        return scopeList.filter(s => !s.startsWith("wicked:"));
    }

    private tokenRefreshToken(tokenRequest: TokenRequest, callback: AccessTokenCallback) {
        debug('tokenRefreshToken()');
        const instance = this;
        // Client validation and all that stuff can be done in the OAuth2 adapter,
        // but we still need to verify that the user for which the refresh token was
        // created is still a valid user.

        // TODO: For pass-through APIs, this cannot be used.
        const refreshToken = tokenRequest.refresh_token;
        tokens.getTokenDataByRefreshToken(refreshToken, function (err, tokenInfo) {
            if (err)
                return failOAuth(400, 'invalid_request', 'could not retrieve information on the given refresh token.', err, callback);

            debug('refresh token info:');
            debug(tokenInfo);

            kongUtils.lookupApiFromKongCredential(tokenInfo.credential_id, function (err, apiInfo) {
                if (err)
                    return failOAuth(500, 'server_error', 'could not lookup API from given refresh token.', err, callback);

                // Check for passthrough scopes and users
                if (apiInfo.passthroughUsers && !apiInfo.passthroughScopeUrl) {
                    return failOAuth(500, 'server_error', 'when using the combination of passthrough users and not retrieving the scope from a third party, refresh tokens cannot be used.', callback);
                } else if (!apiInfo.passthroughUsers && apiInfo.passthroughScopeUrl) {
                    // wicked manages the users, but scope is calculated by somebody else
                    return failOAuth(500, 'server_error', 'wicked managed users and passthrough scope URL is not yet implemented (spec unclear).', callback);
                } else if (!apiInfo.passthroughUsers && !apiInfo.passthroughScopeUrl) {
                    // Normal case
                    const userId = GenericOAuth2Router.extractUserId(tokenInfo.authenticated_userid);
                    if (!userId)
                        return failOAuth(500, 'server_error', 'could not correctly retrieve authenticated user id from refresh token', callback);
                    instance.idp.checkRefreshToken(tokenInfo, (err, refreshCheckResult) => {
                        // TODO: This might be possible to do for all APIs, e.g. check for the previously
                        // created user (in wicked). If not present -> Don't refresh. We can still keep
                        // the callback to the IdP for additional things (I can't imagine what right now though).
                        if (err)
                            return failOAuth(500, 'server_error', 'checking the refresh token returned an unexpected error.', err, callback);
                        wicked.getUser(userId, function (err, userInfo) {
                            if (err)
                                return failOAuth(400, 'invalid_request', 'user associated with refresh token is not a valid user (anymore)', err, callback);
                            debug('wicked local user info:');
                            debug(userInfo);
                            const oidcProfile = utilsOAuth2.wickedUserInfoToOidcProfile(userInfo);
                            tokenRequest.session_data = oidcProfile;
                            // Now delegate to oauth2 adapter:
                            oauth2.token(tokenRequest, callback);
                        });
                    });
                } else {
                    // Passthrough users and passthrough scope URL, the other usual case if the user
                    // is not the resource owner. Ask third party.
                    const tempProfile: OidcProfile = {
                        sub: tokenInfo.authenticated_userid
                    };
                    const scopes = GenericOAuth2Router.cleanupScopeString(tokenInfo.scope);
                    instance.resolvePassthroughScope(scopes, tempProfile, apiInfo.passthroughScopeUrl, (err, scopeResponse: PassthroughScopeResponse) => {
                        if (err)
                            return failError(500, err, callback);
                        tokenRequest.session_data = tempProfile;
                        // We will have to rewrite this to a "password" grant, as we cannot change the scope otherwise
                        tokenRequest.grant_type = 'password';
                        tokenRequest.authenticated_userid = scopeResponse.authenticated_userid;
                        tokenRequest.scope = scopeResponse.authenticated_scope;

                        oauth2.token(tokenRequest, (err, accessToken: AccessToken) => {
                            if (err)
                                return callback(err);
                            // Delete the old token
                            tokens.deleteTokens(tokenInfo.access_token, null, (err) => {
                                if (err)
                                    error(err);
                            });
                            return callback(null, accessToken);
                        });
                    });
                }
            });
        });
    }
}
