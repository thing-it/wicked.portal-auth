'use strict';

import { WickedApiScopes, WickedApi, WickedSubscriptionInfo, WickedUserInfo } from "./wicked-types";
import { WickedApiScopesCallback, AuthRequest, AuthRequestCallback, SubscriptionValidationCallback, ValidatedScopesCallback, TokenRequest, SimpleCallback, TokenInfoCallback, OidcProfile, OidcProfileCallback, AccessTokenCallback, AuthResponse, SubscriptionValidation, OAuth2Request } from "./types";

const async = require('async');
const { debug, info, warn, error } = require('portal-env').Logger('portal-auth:utils-oauth2');
const wicked = require('wicked-sdk');
const request = require('request');

import { failMessage, failError, failOAuth, makeError } from './utils-fail';
import { profileStore } from './profile-store';

import { utils } from './utils';
import { oauth2 } from '../kong-oauth2/oauth2';
import { tokens } from '../kong-oauth2/tokens';

export class UtilsOAuth2 {

    constructor() {
        debug(`UtilsOAuth2()`);
    }

    private _apiScopes: { [apiId: string]: WickedApiScopes } = {};
    public getApiScopes = (apiId: string, callback: WickedApiScopesCallback) => {
        debug(`getApiScopes(${apiId})`);
        const instance = this;
        // Check cache first
        if (this._apiScopes[apiId])
            return callback(null, this._apiScopes[apiId]);
        debug('getApiScopes: Not present in cache, fetching.');
        wicked.apiGet(`apis/${apiId}`, function (err, api: WickedApi) {
            if (err) {
                debug('getApiScopes: Fetching API scopes errored.');
                debug(err);
                return callback(err);
            }
            // TBD: Is it good to return an error here?
            if (!api || !api.settings)
                return callback(new Error(`API ${apiId} does not have settings section`));
            debug('getApiScopes: Succeeded, storing.');
            debug('api.settings.scopes: ' + JSON.stringify(api.settings.scopes));
            instance._apiScopes[apiId] = api.settings.scopes || {};
            return callback(null, instance._apiScopes[apiId]);
        });
    };

    public validateAuthorizeRequest = (authRequest: AuthRequest, callback: SubscriptionValidationCallback) => {
        debug(`validateAuthorizeRequest(${authRequest})`);
        if (authRequest.response_type !== 'token' &&
            authRequest.response_type !== 'code')
            return failMessage(400, `Invalid response_type ${authRequest.response_type}`, callback);
        if (!authRequest.client_id)
            return failMessage(400, 'Invalid or empty client_id.', callback);
        if (!authRequest.redirect_uri)
            return failMessage(400, 'Invalid or empty redirect_uri', callback);
        this.validateSubscription(authRequest, function (err, subsValidation: SubscriptionValidation) {
            if (err)
                return callback(err);
            const application = subsValidation.subsInfo.application;
            // Now we have a redirect_uri; we can now make use of failOAuth
            if (!application.redirectUri)
                return failOAuth(400, 'invalid_request', 'The application associated with the given client_id does not have a registered redirect_uri.', callback);

            // Verify redirect_uri from application, has to match what is passed in
            const uri1 = utils.stripTrailingSlash(authRequest.redirect_uri);
            const uri2 = utils.stripTrailingSlash(subsValidation.subsInfo.application.redirectUri);

            if (uri1 !== uri2)
                return failOAuth(400, 'invalid_request', 'The provided redirect_uri does not match the registered redirect_uri', callback);

            // Success
            return callback(null, subsValidation);
        });
    };

    public validateSubscription = (oauthRequest: OAuth2Request, callback: SubscriptionValidationCallback) => {
        debug('validateSubscription()');
        wicked.getSubscriptionByClientId(oauthRequest.client_id, oauthRequest.api_id, function (err, subsInfo: WickedSubscriptionInfo) {
            if (err)
                return failOAuth(400, 'invalid_request', 'could not validate client_id and API subscription', err, callback);
            // Do we have a trusted subscription?
            let trusted = false;
            if (subsInfo.subscription && subsInfo.subscription.trusted) {
                debug('validateAuthorizeRequest: Trusted subscription detected.');
                // Yes, note that in the authRequest
                trusted = true;
            }
            if (!subsInfo.application || !subsInfo.application.id)
                return failOAuth(500, 'server_error', 'Subscription information does not contain a valid application id', callback);

            oauthRequest.app_id = subsInfo.application.id;
            const returnValues: SubscriptionValidation = {
                subsInfo: subsInfo,
                trusted: trusted,
            };

            return callback(null, returnValues); // All's good for now
        });
    };

    public validateApiScopes = (apiId: string, scope: string, subIsTrusted: boolean, callback: ValidatedScopesCallback) => {
        debug(`validateApiScopes(${apiId}, ${scope})`);

        this.getApiScopes(apiId, function (err, apiScopes) {
            if (err)
                return failError(500, err, callback);

            let requestScope = scope;
            if (!requestScope) {
                debug('validateApiScopes: No scopes requested.');
                requestScope = '';
            }

            let scopes = [] as string[];
            if (requestScope)
                scopes = requestScope.split(' ');
            else
                scopes = [];

            const validatedScopes = [] as string[];
            // Pass upstream if we changed the scopes (e.g. for a trusted application)
            let scopesDiffer = false;
            if (!subIsTrusted) {
                debug('validateApiScopes: Non-trusted subscription.');
                for (let i = 0; i < scopes.length; ++i) {
                    const thisScope = scopes[i];
                    if (!apiScopes[thisScope])
                        return failMessage(400, `Invalid or unknown scope "${thisScope}".`, callback);
                    validatedScopes.push(thisScope);
                }
            } else {
                debug('validateApiScopes: Trusted subscription.');
                // apiScopes is a map of scopes
                for (let aScope in apiScopes) {
                    validatedScopes.push(aScope);
                }
                scopesDiffer = true;
            }
            debug(`validated Scopes: ${validatedScopes}`);

            return callback(null, {
                scopesDiffer: scopesDiffer,
                validatedScopes: validatedScopes
            });
        });
    };

    public makeTokenRequest(req, apiId: string, authMethodId: string): TokenRequest {
        // Gather parameters from body. Note that not all parameters
        // are used in all flows.
        return {
            api_id: apiId,
            auth_method: req.app.get('server_name') + ':' + authMethodId,
            grant_type: req.body.grant_type,
            code: req.body.code,
            //redirect_uri: req.body.redirect_uri,
            client_id: req.body.client_id,
            client_secret: req.body.client_secret,
            scope: req.body.scope,
            username: req.body.username,
            password: req.body.password,
            refresh_token: req.body.refresh_token
        };
    };

    public validateTokenRequest = (tokenRequest: TokenRequest, callback: SimpleCallback) => {
        debug(`validateTokenRequest(${tokenRequest})`);

        if (!tokenRequest.grant_type)
            return failOAuth(400, 'invalid_request', 'grant_type is missing.', callback);

        // Different for different grant_types
        if (tokenRequest.grant_type === 'client_credentials') {
            if (!tokenRequest.client_id)
                return failOAuth(400, 'invalid_client', 'client_id is missing.', callback);
            if (!tokenRequest.client_secret)
                return failOAuth(400, 'invalid_client', 'client_secret is missing.', callback);
            return callback(null);
        } else if (tokenRequest.grant_type === 'authorization_code') {
            if (!tokenRequest.code)
                return failOAuth(400, 'invalid_request', 'code is missing.', callback);
            if (!tokenRequest.client_id)
                return failOAuth(400, 'invalid_client', 'client_id is missing.', callback);
            if (!tokenRequest.client_secret)
                return failOAuth(400, 'invalid_client', 'client_secret is missing.', callback);
        } else if (tokenRequest.grant_type === 'password') {
            if (!tokenRequest.client_id)
                return failOAuth(400, 'invalid_client', 'client_id is missing.', callback);
            // For confidential clients, the client_secret will also be checked (by the OAuth2 adapter)
            if (!tokenRequest.username)
                return failOAuth(400, 'invalid_request', 'username is missing.', callback);
            if (!tokenRequest.username)
                return failOAuth(400, 'invalid_request', 'password is missing.', callback);
            // TODO: scopes
        } else if (tokenRequest.grant_type === 'refresh_token') {
            if (!tokenRequest.client_id)
                return failOAuth(400, 'invalid_client', 'client_id is missing.', callback);
            // For confidential clients, the client_secret will also be checked (by the OAuth2 adapter)
            if (!tokenRequest.refresh_token)
                return failOAuth(400, 'invalid_request', 'refresh_token is missing.', callback);
        } else {
            return failOAuth(400, 'unsupported_grant_type', `The grant_type '${tokenRequest.grant_type}' is not supported or is unknown.`, callback);
        }
        return callback(null);
    };

    public tokenClientCredentials = (tokenRequest: TokenRequest, callback: AccessTokenCallback) => {
        debug('tokenClientCredentials()');
        const instance = this;
        this.validateSubscription(tokenRequest, (err, validationResult) => {
            if (err)
                return callback(err);
            instance.validateApiScopes(tokenRequest.api_id, tokenRequest.scope, validationResult.trusted, (err, scopeInfo) => {
                if (err)
                    return callback(err);
                tokenRequest.scope = scopeInfo.validatedScopes;
                // We can just pass this on to the wicked SDK.
                oauth2.token(tokenRequest, callback);
            });
        });
    };

    public tokenAuthorizationCode = (tokenRequest: TokenRequest, callback: AccessTokenCallback) => {
        debug('tokenAuthorizationCode()');
        // We can just pass this on to the wicked SDK, and the register the token.
        oauth2.token(tokenRequest, (err, accessToken) => {
            if (err)
                return callback(err);
            profileStore.retrieve(tokenRequest.code, (err, profile) => {
                if (err)
                    return callback(err);
                accessToken.session_data = profile;
                // We now have to register the access token with the profile
                // Also delete the code from the redis, it's not needed anymore
                async.parallel({
                    deleteToken: (callback) => {
                        // We'll ignore what happens here.
                        profileStore.deleteTokenOrCode(tokenRequest.code);
                        return callback(null);
                    },
                    updateToken: (callback) => {
                        profileStore.registerTokenOrCode(accessToken, tokenRequest.api_id, profile, (err) => {
                            if (err)
                                return callback(err);
                            return callback(null, accessToken);
                        });
                    }
                }, (err, results) => {
                    if (err)
                        return callback(err);
                    return callback(null, accessToken);
                });
            });
        });
    }

    public getProfile(req, res, next) {
        debug(`/profile`);
        // OIDC profile end point, we need this. This is nice. Yeah.
        // res.status(500).json({ message: 'Not yet implemented.' });

        const bearerToken = req.get('authorization');
        if (!bearerToken)
            return failMessage(403, 'Unauthorized', next);
        let accessToken = null;
        if (bearerToken.indexOf(' ') > 0) {
            // assume Bearer xxx
            let tokenSplit = bearerToken.split(' ');
            if (tokenSplit.length !== 2)
                return failOAuth(400, 'invalid_request', 'Invalid Bearer token.', next);
            accessToken = bearerToken.split(' ')[1];
        } else {
            // Assume without "Bearer", just the access token
            accessToken = bearerToken;
        }
        accessToken = accessToken.trim();

        // Read from profile store.
        profileStore.retrieve(accessToken, (err, profile) => {
            if (err || !profile)
                return failOAuth(404, 'invalid_request', 'Not found', next);
            return res.status(200).json(profile);
        });
    }

    public wickedUserInfoToOidcProfile(userInfo: WickedUserInfo): OidcProfile {
        debug('wickedUserInfoToOidcProfile()');
        // Simple mapping to some basic OIDC profile claims
        const oidcProfile = {
            sub: userInfo.id,
            email: userInfo.email,
            email_verified: userInfo.validated
        };
        return oidcProfile;
    };

    public makeOidcProfile = (poolId: string, authResponse: AuthResponse, regInfo, callback) => {
        debug(`makeOidcProfile(${poolId}, ${authResponse.userId})`);
        const userId = authResponse.userId;
        const instance = this;

        // OK; we might be able to get the information from somewhere else, but let's keep
        // it simple.
        async.parallel({
            userInfo: callback => wicked.apiGet(`/users/${userId}`, callback),
            poolInfo: callback => utils.getPoolInfo(poolId, callback)
        }, function (err, results) {
            if (err)
                return callback(err);
            const userInfo = results.userInfo;
            const poolInfo = results.poolInfo;

            const profile = instance.wickedUserInfoToOidcProfile(userInfo);
            // Now let's see what we can map from the registration
            for (let propName in poolInfo.properties) {
                if (!regInfo[propName])
                    continue;
                const propInfo = poolInfo.properties[propName];
                // If the property doesn't include a mapping to an OIDC claim, we can't use it
                if (!propInfo.oidcClaim)
                    continue;
                // Now assign the value to the OIDC claim in the profile
                profile[propInfo.oidcClaim] = regInfo[propName];
            }

            debug('makeOidcProfile() assembled the following profile:');
            debug(profile);

            return callback(null, profile);
        });
    }
};

export const utilsOAuth2 = new UtilsOAuth2();
