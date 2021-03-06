'use strict';

import * as qs from 'querystring';
import { SimpleCallback, StringCallback, AuthRequest, TokenRequest, OAuth2Request, AccessToken, AccessTokenCallback } from '../common/types';
import { WickedApplication, WickedSubscription, KongApi, KongApiCallback, WickedApi, WickedApiCallback } from '../common/wicked-types';
const { debug, info, warn, error } = require('portal-env').Logger('portal-auth:oauth2');
const async = require('async');
const wicked = require('wicked-sdk');
const request = require('request');

import { utils } from '../common/utils';
import { kongUtils }  from './kong-utils';
import { failOAuth } from '../common/utils-fail';

// We need this to accept self signed and Let's Encrypt certificates
var https = require('https');
var agentOptions = { rejectUnauthorized: false };
var sslAgent = new https.Agent(agentOptions);

// interface InputData {
//     grant_type?: string,
//     response_type?: string,
//     authenticated_userid: string,
//     auth_method: string,
//     api_id: string,
//     client_id?: string,
//     client_secret?: string,
//     refresh_token?: string,
//     code?: string,
//     scope: string[],
//     session_data?: string
// }

// interface SubscriptionInfo {
//     application: string,
//     api: string,
//     auth: string,
//     plan: string,
//     clientId: string,
//     clientSecret: string,
//     trusted: boolean
// }

// interface ApplicationInfo {
//     id: string,
//     name: string
//     redirectUri: string,
//     confidential: boolean
// }

interface ConsumerInfo {
    id: string,
    username: string,
    custom_id: string
}

interface KongOAuth2Config {
    provision_key: string,
    enable_client_credentials: boolean,
    enable_implicit_grant: boolean,
    enable_authorization_code: boolean,
    enable_password_grant: boolean
}

interface OAuthInfo {
    inputData: OAuth2Request,
    oauth2Config: KongOAuth2Config,
    provisionKey: string,
    subsInfo: WickedSubscription,
    appInfo: WickedApplication,
    consumer: ConsumerInfo,
    apiInfo: KongApi,
}

interface OAuthInfoCallback {
    (err, oauthInfo?: OAuthInfo): void
}

interface AuthorizeOAuthInfo extends OAuthInfo {
    inputData: AuthRequest,
    redirectUri?: string
}

interface TokenOAuthInfo extends OAuthInfo {
    inputData: TokenRequest,
    accessToken?: AccessToken
}

interface AuthorizeOAuthInfoCallback {
    (err, oauthInfo?: AuthorizeOAuthInfo): void
}

interface TokenOAuthInfoCallback {
    (err, oauthInfo?: TokenOAuthInfo): void
}

interface RedirectUri {
    redirect_uri: string,
    session_data?: string
}

interface RedirectUriCallback {
    (err, authorizeData?: RedirectUri): void
}

interface RequestHeaders {
    [name: string]: string
}

interface AuthorizeRequestPayload {
    url: string,
    headers: RequestHeaders,
    agent: any,
    json: boolean,
    body: object
}

interface AuthorizeRequestPayloadCallback {
    (err, authorizeRequest?: AuthorizeRequestPayload): void
}

interface TokenKongInvoker {
    (oauthInfo: OAuthInfo, callback: TokenOAuthInfoCallback): void
}

interface AuthorizeKongInvoker {
    (oauthInfo: OAuthInfo, callback: AuthorizeOAuthInfoCallback): void
}

interface TokenRequestPayload {
    url: string,
    headers: RequestHeaders,
    agent: any,
    json: boolean,
    body: object
}

interface TokenRequestPayloadCallback {
    (err, tokenRequest?: TokenRequestPayload): void
}

export const oauth2 = {
    authorize: function (inputData: AuthRequest, callback: RedirectUriCallback) {
        validateResponseType(inputData, function (err) {
            if (err)
                return callback(err);
            switch (inputData.response_type) {
                case 'token':
                    return authorizeImplicit(inputData, callback);
                case 'code':
                    return authorizeAuthorizationCode(inputData, callback);
            }
            return failOAuth(400, 'invalid_request', 'unknown error or response_type invalid.', callback);
        });
    },

    token: function (inputData: TokenRequest, callback: AccessTokenCallback) {
        validateGrantType(inputData, function (err) {
            if (err)
                return callback(err);
            switch (inputData.grant_type) {
                case 'client_credentials':
                    return tokenClientCredentials(inputData, callback);
                case 'authorization_code':
                    return tokenAuthorizationCode(inputData, callback);
                case 'refresh_token':
                    return tokenRefreshToken(inputData, callback);
                case 'password':
                    return tokenPasswordGrant(inputData, callback);
            }
            return failOAuth(400, 'invalid_request', 'unknown error or grant_type invalid', callback);
        });
    }
};

// -----------------------------------

function validateResponseType(inputData: AuthRequest, callback: SimpleCallback) {
    debug('validateResponseType()');
    debug('responseType: ' + inputData.response_type);
    if (!inputData.response_type)
        return failOAuth(400, 'invalid_request', 'response_type is missing', callback);
    if (!inputData.auth_method)
        return failOAuth(400, 'invalid_request', 'auth_method is missing', callback);
    if (!inputData.api_id)
        return failOAuth(400, 'invalid_request', 'api_id is missing', callback);
    switch (inputData.response_type) {
        case "token":
        case "code":
            return callback(null);
    }
    return failOAuth(400, 'unsupported_response_type', `invalid response_type '${inputData.response_type}'`, callback);
}

function validateGrantType(inputData: TokenRequest, callback: SimpleCallback) {
    debug('validateGrantType()');
    debug(`grant_type: ${inputData.grant_type}`);
    if (!inputData.grant_type)
        return failOAuth(400, 'invalid_request', 'grant_type is missing', callback);
    if (!inputData.auth_method)
        return failOAuth(400, 'invalid_request', 'auth_method is missing', callback);
    if (!inputData.api_id)
        return failOAuth(400, 'invalid_request', 'api_id is missing', callback);
    switch (inputData.grant_type) {
        case 'authorization_code':
        case 'client_credentials':
        case 'refresh_token':
        case 'password':
            return callback(null);
    }
    return failOAuth(400, 'invalid_request', `invalid grant_type ${inputData.grant_type}`, callback);
}

// -----------------------------------
// IMPLICIT GRANT
// -----------------------------------

function authorizeImplicit(inputData: AuthRequest, callback: RedirectUriCallback) {
    debug('authorizeImplicit()');
    // debug(inputData);
    async.series({
        validate: function (callback) { validateImplicit(inputData, callback); },
        redirectUri: function (callback) { authorizeImplicitInternal(inputData, callback); }
    }, function (err, results) {
        if (err)
            return callback(err);

        // Fetch result of authorizeImplicitInternal
        const returnValue = {
            redirect_uri: results.redirectUri,
            session_data: null
        };
        // If session_data was provided, also return it
        if (inputData.session_data)
            returnValue.session_data = inputData.session_data;

        callback(null, returnValue);
    });
}

function validateImplicit(inputData: AuthRequest, callback: SimpleCallback) {
    debug('validateImplicit()');
    debug('authRequest: ' + JSON.stringify(inputData));
    if (!inputData.client_id)
        return failOAuth(400, 'invalid_request', 'client_id is missing', callback);
    if (inputData.client_secret)
        return failOAuth(400, 'invalid_request', 'client_secret must not be passed in', callback);
    if (!inputData.authenticated_userid)
        return failOAuth(400, 'invalid_request', 'authenticated_userid is missing', callback);
    if (inputData.scope) {
        if ((typeof (inputData.scope) !== 'string') &&
            !Array.isArray(inputData.scope))
            return failOAuth(400, 'invalid_scope', 'scope has to be either a string or a string array', callback);
    }
    callback(null);
}

function authorizeImplicitInternal(inputData: AuthRequest, callback: StringCallback) {
    debug('authorizeImplicitInternal()');
    return authorizeFlow(inputData, authorizeImplicitKong, callback);
}

function authorizeImplicitKong(oauthInfo: AuthorizeOAuthInfo, callback: AuthorizeOAuthInfoCallback) {
    debug('authorizeImplicitKong()');
    // Check that the API is configured for implicit grant
    if (!oauthInfo.oauth2Config ||
        !oauthInfo.oauth2Config.enable_implicit_grant) {
        return failOAuth(403, 'unauthorized_client', 'The API ' + oauthInfo.inputData.api_id + ' is not configured for the OAuth2 implicit grant', callback);
    }

    return authorizeWithKong(oauthInfo, 'token', callback);
}

// -----------------------------------
// AUTHORIZATION CODE GRANT - AUTHORIZE
// -----------------------------------

function authorizeAuthorizationCode(inputData: AuthRequest, callback: RedirectUriCallback) {
    debug('authorizeAuthorizationCode()');
    debug(inputData);
    async.series({
        validate: function (callback) { validateAuthorizationCode(inputData, callback); },
        redirectUri: function (callback) { authorizeAuthorizationCodeInternal(inputData, callback); }
    }, function (err, results) {
        if (err)
            return callback(err);

        // Fetch result of authorizeAuthorizationCodeInternal
        const returnValue = {
            redirect_uri: results.redirectUri,
            session_data: null
        };
        // If session_data was provided, also return it
        if (inputData.session_data)
            returnValue.session_data = inputData.session_data;

        callback(null, returnValue);
    });
}

function validateAuthorizationCode(inputData: AuthRequest, callback: SimpleCallback) {
    debug('validateAuthorizationCode()');
    debug('inputData: ' + JSON.stringify(inputData));
    if (!inputData.client_id)
        return failOAuth(400, 'invalid_request', 'client_id is missing', callback);
    if (inputData.client_secret)
        return failOAuth(400, 'invalid_request', 'client_secret must not be passed in', callback);
    if (!inputData.authenticated_userid)
        return failOAuth(400, 'invalid_request', 'authenticated_userid is missing', callback);
    if (inputData.scope) {
        if ((typeof (inputData.scope) !== 'string') &&
            !Array.isArray(inputData.scope))
            return failOAuth(400, 'invalid_scope', 'scope has to be either a string or a string array', callback);
    }
    callback(null);
}

function authorizeAuthorizationCodeInternal(inputData: AuthRequest, callback: StringCallback) {
    debug('authorizeAuthorizationCodeInternal()');
    return authorizeFlow(inputData, authorizeAuthorizationCodeKong, callback);
}

function authorizeAuthorizationCodeKong(oauthInfo: AuthorizeOAuthInfo, callback: AuthorizeOAuthInfoCallback) {
    debug('authorizeAuthorizationCodeKong()');
    // Check that the API is configured for authorization code grant
    if (!oauthInfo.oauth2Config ||
        !oauthInfo.oauth2Config.enable_authorization_code)
        return failOAuth(403, 'unauthorized_client', 'The API ' + oauthInfo.inputData.api_id + ' is not configured for the OAuth2 Authorization Code grant.', callback);

    return authorizeWithKong(oauthInfo, 'code', callback);
}

function authorizeWithKong(oauthInfo: AuthorizeOAuthInfo, responseType: string, callback: AuthorizeOAuthInfoCallback) {
    debug('authorizeWithKong()');
    async.waterfall([
        callback => getAuthorizeRequest(responseType, oauthInfo, callback),
        (authorizeRequest, callback) => postAuthorizeRequest(authorizeRequest, callback)
    ], function (err, redirectUri) {
        if (err)
            return callback(err);
        oauthInfo.redirectUri = redirectUri;
        return callback(null, oauthInfo);
    });
}

// -----------------------------------
// AUTHORIZATION CODE GRANT - TOKEN
// -----------------------------------

function tokenAuthorizationCode(inputData: TokenRequest, callback: AccessTokenCallback): void {
    debug('tokenAuthorizationCode()');
    debug(inputData);
    async.series({
        validate: function (callback) { validateTokenAuthorizationCode(inputData, callback); },
        accessToken: function (callback) { tokenAuthorizationCodeInternal(inputData, callback); }
    }, function (err, result) {
        if (err)
            return callback(err);
        return callback(null, result.accessToken);
    });
}

function validateTokenAuthorizationCode(inputData: TokenRequest, callback: SimpleCallback): void {
    debug('validateTokenAuthorizationCode()');
    if (!inputData.client_id)
        return failOAuth(400, 'invalid_request', 'client_id is missing', callback);
    if (!inputData.client_secret)
        return failOAuth(400, 'invalid_request', 'client_secret is missing', callback);
    if (!inputData.code)
        return failOAuth(400, 'invalid_request', 'code is missing', callback);
    callback(null);
}

function tokenAuthorizationCodeInternal(inputData: TokenRequest, callback: AccessTokenCallback) {
    debug('tokenAuthorizationCodeInternal()');
    return tokenFlow(inputData, tokenAuthorizationCodeKong, callback);
}

function tokenAuthorizationCodeKong(oauthInfo: TokenOAuthInfo, callback: TokenOAuthInfoCallback) {
    debug(oauthInfo.oauth2Config);
    if (!oauthInfo.oauth2Config ||
        !oauthInfo.oauth2Config.enable_authorization_code)
        return failOAuth(403, 'unauthorized_client', 'The API ' + oauthInfo.inputData.api_id + ' is not configured for the OAuth2 authorization code grant.', callback);

    return tokenWithKong(oauthInfo, 'authorization_code', callback);
}

function tokenWithKong(oauthInfo: TokenOAuthInfo, grantType: string, callback: TokenOAuthInfoCallback) {
    async.waterfall([
        callback => getTokenRequest(grantType, oauthInfo, callback),
        (tokenRequest, callback) => postTokenRequest(tokenRequest, callback)
    ], function (err, accessToken) {
        if (err)
            return callback(err);
        oauthInfo.accessToken = accessToken;
        return callback(null, oauthInfo);
    });
}

// -----------------------------------
// CLIENT CREDENTIALS
// -----------------------------------

function tokenClientCredentials(inputData: TokenRequest, callback: AccessTokenCallback) {
    debug('tokenClientCredentials()');
    debug(inputData);
    async.series({
        validate: function (callback: SimpleCallback) { validateClientCredentials(inputData, callback); },
        accessToken: function (callback: AccessTokenCallback) { tokenClientCredentialsInternal(inputData, callback); }
    }, function (err, result) {
        if (err)
            return callback(err);
        const returnValue = result.accessToken as AccessToken;
        // If session_data was provided, also return it
        if (inputData.session_data)
            returnValue.session_data = inputData.session_data;
        return callback(null, returnValue);
    });
}

function validateClientCredentials(inputData: TokenRequest, callback: SimpleCallback) {
    debug('validateClientCredentials()');
    if (!inputData.client_id)
        return failOAuth(400, 'invalid_request', 'client_id is missing', callback);
    if (!inputData.client_secret)
        return failOAuth(400, 'invalid_request', 'client_secret is missing', callback);
    if (inputData.scope) {
        if ((typeof (inputData.scope) !== 'string') &&
            !Array.isArray(inputData.scope))
            return failOAuth(400, 'invalid_scope', 'scope has to be either a string or a string array', callback);
    }
    callback(null);
}

function tokenClientCredentialsInternal(inputData: TokenRequest, callback: AccessTokenCallback) {
    return tokenFlow(inputData, tokenClientCredentialsKong, callback);
}

function tokenClientCredentialsKong(oauthInfo: TokenOAuthInfo, callback: TokenOAuthInfoCallback) {
    debug('tokenClientCredentialsKong()');
    debug(oauthInfo.oauth2Config);
    if (!oauthInfo.oauth2Config ||
        !oauthInfo.oauth2Config.enable_client_credentials)
        return failOAuth(403, 'unauthorized_client', 'The API ' + oauthInfo.inputData.api_id + ' is not configured for the OAuth2 client credentials grant.', callback);

    return tokenWithKong(oauthInfo, 'client_credentials', callback);
}

// -----------------------------------
// RESOURCE OWNER PASSWORD GRANT
// -----------------------------------

function tokenPasswordGrant(inputData: TokenRequest, callback: AccessTokenCallback) {
    debug('tokenPasswordGrant()');
    debug(inputData);
    async.series({
        validate: function (callback) { validatePasswordGrant(inputData, callback); },
        accessToken: function (callback) { tokenPasswordGrantInternal(inputData, callback); }
    }, function (err, result) {
        if (err)
            return callback(err);
        const returnValue = result.accessToken;
        // If session_data was provided, also return it
        if (inputData.session_data)
            returnValue.session_data = inputData.session_data;
        return callback(null, returnValue);
    });
}

function validatePasswordGrant(inputData: TokenRequest, callback: SimpleCallback) {
    debug('validatePasswordGrant()');
    if (!inputData.client_id)
        return failOAuth(400, 'invalid_request', 'client_id is missing', callback);
    // client_secret validation is done in validateTokenClientCredentials.
    if (inputData.scope) {
        if ((typeof (inputData.scope) !== 'string') &&
            !Array.isArray(inputData.scope))
            return failOAuth(400, 'invalid_scope', 'scope has to be either a string or a string array', callback);
    }
    if (!inputData.authenticated_userid)
        return failOAuth(400, 'invalid_request', 'authenticated_userid is missing', callback);
    return callback(null);
}

function tokenPasswordGrantInternal(inputData: TokenRequest, callback: AccessTokenCallback) {
    debug('tokenAuthorizationCodeInternal()');
    return tokenFlow(inputData, tokenPasswordGrantKong, callback);
}

function tokenPasswordGrantKong(oauthInfo: TokenOAuthInfo, callback: TokenOAuthInfoCallback) {
    debug(oauthInfo.oauth2Config);
    if (!oauthInfo.oauth2Config ||
        !oauthInfo.oauth2Config.enable_password_grant)
        return failOAuth(403, 'unauthorized_client', 'The API ' + oauthInfo.inputData.api_id + ' is not configured for the OAuth2 resource owner password grant.', callback);

    return tokenWithKong(oauthInfo, 'password', callback);
}

// -----------------------------------
// REFRESH TOKEN
// -----------------------------------

function tokenRefreshToken(inputData: TokenRequest, callback: AccessTokenCallback) {
    debug('tokenRefreshToken()');
    debug(inputData);
    async.series({
        validate: function (callback) { validateRefreshToken(inputData, callback); },
        accessToken: function (callback) { tokenRefreshTokenInternal(inputData, callback); }
    }, function (err, result) {
        if (err)
            return callback(err);
        const returnValue = result.accessToken;
        // If session_data was provided, also return it
        if (inputData.session_data)
            returnValue.session_data = inputData.session_data;
        return callback(null, returnValue);
    });
}

function validateRefreshToken(inputData: TokenRequest, callback: SimpleCallback) {
    debug('validateRefreshToken()');
    if (!inputData.client_id)
        return failOAuth(400, 'invalid_request', 'client_id is missing', callback);
    // client_secret validation for confidential clients is done in validateTokenClientCredentials
    if (!inputData.refresh_token)
        return failOAuth(400, 'invalid_request', 'refresh_token is missing', callback);
    if (inputData.scope) {
        if ((typeof (inputData.scope) !== 'string') &&
            !Array.isArray(inputData.scope))
            return failOAuth(400, 'invalid_scope', 'scope has to be either a string or a string array', callback);
    }
    return callback(null);
}

function tokenRefreshTokenInternal(inputData: TokenRequest, callback: AccessTokenCallback) {
    debug('tokenRefreshTokenInternal()');
    return tokenFlow(inputData, tokenRefreshTokenKong, callback);
}

function tokenRefreshTokenKong(oauthInfo: TokenOAuthInfo, callback: TokenOAuthInfoCallback) {
    debug('tokenRefreshTokenKong()');
    return tokenWithKong(oauthInfo, 'refresh_token', callback);
}

// -----------------------------------
// AUTHORIZATION ENDPOINT HELPER METHODS
// -----------------------------------

function authorizeFlow(inputData: AuthRequest, authorizeKongInvoker: AuthorizeKongInvoker, callback: StringCallback) {
    debug('authorizeFlow()');
    // We'll add info to this thing along the way; this is how it will look:
    // {
    //   inputData: {
    //     authenticated_userid: (user custom ID, e.g. from 3rd party DB),
    //     api_id: (API ID)
    //     client_id: (The app's client ID, from subscription)
    //     auth_server: (optional, which auth server is calling? Used to check that API is configured to use this auth server)
    //     scope: [ list of wanted scopes ] (optional, depending on API definition)
    //   }
    //   provisionKey: ...
    //   subsInfo: {
    //     application: (app ID)
    //     api: (api ID)
    //     auth: 'oauth2',
    //     plan: (plan ID)
    //     clientId: (client ID)
    //     clientSecret: (client secret)
    //     trusted: false
    //     ...
    //   },
    //   appInfo: {
    //     id: (app ID),
    //     name: (Application friendly name),
    //     redirectUri: (App's redirect URI)   
    //     confidential: false
    //   },
    //   consumer: {
    //     id: (Kong consumer ID),
    //     username: (app id)$(api_id)
    //     custom_id: (subscription id)
    //   },
    //   apiInfo: {
    //     strip_uri: true,
    //     preserve_host: false,
    //     name: "mobile",
    //     uris : [ "/mobile/v1" ],
    //     id: "7baec4f7-131d-44e9-a746-312352cedab1",
    //     upstream_url: "https://upstream.url/api/v1",
    //     created_at: 1477320419000
    //   }
    //   redirectUri: (redirect URI including access token)
    // }
    const oauthInfo = { inputData: inputData } as AuthorizeOAuthInfo;

    async.series([
        callback => lookupSubscription(oauthInfo, callback),
        callback => getOAuth2Config(oauthInfo, callback),
        //callback => lookupConsumer(oauthInfo, callback), // What was this for?
        callback => lookupApi(oauthInfo, callback),
        callback => authorizeKongInvoker(oauthInfo, callback)
    ], function (err, results) {
        debug('authorizeFlow async series returned.');
        if (err) {
            debug('but failed.');
            return callback(err);
        }

        // Oh, wow, that worked.
        callback(null, oauthInfo.redirectUri);
    });
}

function getAuthorizeRequest(responseType: string, oauthInfo: AuthorizeOAuthInfo, callback: AuthorizeRequestPayloadCallback) {
    const apiUrl = wicked.getExternalApiUrl();
    const authorizeUrl = buildKongUrl(apiUrl, oauthInfo.apiInfo.uris[0], '/oauth2/authorize');
    debug('authorizeUrl: ' + authorizeUrl);

    let headers = null;
    let agent = null;

    // Workaround for local connections and testing
    const wickedGlobals = wicked.getGlobals();
    if ('http' === wickedGlobals.network.schema) {
        headers = { 'X-Forwarded-Proto': 'https' };
    } else if ('https' === wickedGlobals.network.schema) {
        // Make sure we accept self signed certs
        agent = sslAgent;
    }

    let scope = null;
    if (oauthInfo.inputData.scope) {
        let s = oauthInfo.inputData.scope;
        if (typeof (s) === 'string')
            scope = s;
        else if (Array.isArray(s))
            scope = s.join(' ');
        else // else: what?
            return failOAuth(400, 'invalid_scope', 'unknown type of scope input parameter: ' + typeof (s), callback);
    }
    debug('requested scope: ' + scope);

    const oauthBody = {
        response_type: responseType,
        provision_key: oauthInfo.provisionKey,
        client_id: oauthInfo.subsInfo.clientId,
        redirect_uri: oauthInfo.appInfo.redirectUri,
        authenticated_userid: oauthInfo.inputData.authenticated_userid,
        scope: null
    };
    if (scope)
        oauthBody.scope = scope;
    debug(oauthBody);

    const requestParameters = {
        url: authorizeUrl,
        headers: headers,
        agent: agent,
        json: true,
        body: oauthBody
    };

    return callback(null, requestParameters);
}

function postAuthorizeRequest(authorizeRequest: AuthorizeRequestPayload, callback: StringCallback) {
    debug('postAuthorizeRequest()');
    // Jetzt kommt der spannende Moment, wo der Frosch ins Wasser rennt
    request.post(authorizeRequest, function (err, res, body) {
        if (err) {
            return failOAuth(500, 'server_error', 'calling kong authorize returned an error', err, callback);
        }
        const jsonBody = utils.getJson(body);
        if (res.statusCode > 299) {
            debug('postAuthorizeRequest: Kong did not create a redirect URI, response body:');
            debug(JSON.stringify(jsonBody));
            // Kong _should_ return an RFC6479 compliant response; let's see
            const error = jsonBody.error || 'server_error';
            const message = jsonBody.error_description || 'authorize for user with Kong failed: ' + utils.getText(body);
            const statusCode = res.statusCode || 500;
            return failOAuth(statusCode, error, message, callback);
        }
        debug('Kong authorize response:');
        debug(body);
        return callback(null, jsonBody.redirect_uri);
    });
}

// -----------------------------------
// TOKEN ENDPOINT HELPER METHODS
// -----------------------------------

function tokenFlow(inputData: TokenRequest, tokenKongInvoker: TokenKongInvoker, callback: AccessTokenCallback) {
    debug('tokenFlow()');
    const oauthInfo = { inputData: inputData } as TokenOAuthInfo;

    async.series([
        callback => lookupSubscription(oauthInfo, callback),
        callback => validateTokenClientCredentials(oauthInfo, callback),
        callback => getOAuth2Config(oauthInfo, callback),
        //callback => lookupConsumer(oauthInfo, callback), // What was this for?
        callback => lookupApi(oauthInfo, callback),
        callback => tokenKongInvoker(oauthInfo, callback)
    ], function (err, result) {
        debug('tokenFlow async series returned.');
        if (err) {
            debug('but failed.');
            return callback(err);
        }

        // Oh, wow, that worked.
        callback(null, oauthInfo.accessToken);
    });
}

// Note that this is not necessary for the /authorize end point, only for the token
// end point. Maybe it might be a good idea to make this behaviour configurable.
function validateTokenClientCredentials(oauthInfo: TokenOAuthInfo, callback: TokenOAuthInfoCallback) {
    debug('validateTokenClientCredentials()');
    const appId = oauthInfo.appInfo.id;
    const grantType = oauthInfo.inputData.grant_type;
    switch (grantType) {
        case 'password':
        case 'refresh_token':
            // Confidential clients MUST present their client_secret, non-confidential clients
            // MUST NOT present their client_secret.
            if (!oauthInfo.appInfo.confidential) {
                if (oauthInfo.inputData.client_secret)
                    return failOAuth(403, 'unauthorized_client', `client_secret is being passed; he application ${appId} is not declared as a confidential application; it must not contain and pass its client_secret using the ${grantType} grant.`, callback);
            } else {
                if (!oauthInfo.inputData.client_secret)
                    return failOAuth(403, 'unauthorized_client', `client_secret is missing; the application ${appId} is declared as a confidential application; it must pass its client_secret using the ${grantType} grant.`, callback);
            }

            break;
        // These two grants *require* a confidential client, i.e. one which is able
        // to store secrets confidentially (not an app or SPA).
        case 'client_credentials':
        case 'authorization_code':
            if (!oauthInfo.appInfo.confidential)
                return failOAuth(403, 'unauthorized_client', `the application ${appId} is not declared as a confidential application, thus cannot request access tokens via grant ${grantType}.`, callback);
            if (!oauthInfo.inputData.client_secret)
                return failOAuth(400, 'unauthorized_client', 'client_secret is missing.', callback);
            break;
    }
    return callback(null, oauthInfo);
}

function getTokenRequest(grantType: string, oauthInfo: TokenOAuthInfo, callback: TokenRequestPayloadCallback) {
    const apiUrl = wicked.getExternalApiUrl();
    const tokenUrl = buildKongUrl(apiUrl, oauthInfo.apiInfo.uris[0], '/oauth2/token');
    debug('tokenUrl: ' + tokenUrl);

    let headers: RequestHeaders = null;
    let agent = null;

    // Workaround for local connections and testing
    const wickedGlobals = wicked.getGlobals();
    if ('http' === wickedGlobals.network.schema) {
        headers = { 'X-Forwarded-Proto': 'https' };
    } else if ('https' === wickedGlobals.network.schema) {
        // Make sure we accept self signed certs
        agent = sslAgent;
    }

    let scope = null;
    if (oauthInfo.inputData.scope) {
        let s = oauthInfo.inputData.scope;
        if (typeof (s) === 'string')
            scope = s;
        else if (Array.isArray(s))
            scope = s.join(' ');
        else // else: what?
            return failOAuth(400, 'invalid_scope', 'unknown type of scope input parameter: ' + typeof (s), callback);
    }

    let tokenBody;
    switch (grantType) {
        case 'client_credentials':
            tokenBody = {
                grant_type: grantType,
                client_id: oauthInfo.inputData.client_id,
                client_secret: oauthInfo.inputData.client_secret,
                scope: scope
            };
            break;
        case 'authorization_code':
            tokenBody = {
                grant_type: grantType,
                client_id: oauthInfo.inputData.client_id,
                client_secret: oauthInfo.inputData.client_secret,
                code: oauthInfo.inputData.code,
                redirect_uri: oauthInfo.appInfo.redirectUri
            };
            break;
        case 'password':
            tokenBody = {
                grant_type: grantType,
                client_id: oauthInfo.inputData.client_id,
                client_secret: oauthInfo.inputData.client_secret,
                provision_key: oauthInfo.provisionKey,
                authenticated_userid: oauthInfo.inputData.authenticated_userid,
                scope: scope
            };
            break;
        case 'refresh_token':
            tokenBody = {
                grant_type: grantType,
                client_id: oauthInfo.inputData.client_id,
                client_secret: oauthInfo.inputData.client_secret,
                refresh_token: oauthInfo.inputData.refresh_token
            };
            break;
        default:
            return failOAuth(400, 'invalid_request', `invalid grant_type ${grantType}`, callback);
    }

    // Kong is very picky about this
    if (!scope && tokenBody.hasOwnProperty('scope'))
        delete tokenBody.scope;

    const tokenRequest = {
        url: tokenUrl,
        headers: headers,
        agent: agent,
        json: true,
        body: tokenBody
    } as TokenRequestPayload;

    debug(JSON.stringify(tokenRequest, null, 2));

    return callback(null, tokenRequest);
}

function postTokenRequest(tokenRequest: TokenRequestPayload, callback: AccessTokenCallback) {
    request.post(tokenRequest, function (err, res, body) {
        if (err)
            return failOAuth(500, 'server_error', 'calling kong token endpoint returned an error', err, callback);
        const jsonBody = utils.getJson(body);
        // jsonBody is now either of AccessToken type, or it contains an error
        // and an error_description
        if (res.statusCode > 299) {
            debug('postTokenRequest: Kong did not create a token, response body:');
            debug(JSON.stringify(jsonBody));
            // Kong _should_ return an RFC6479 compliant response; let's see
            const error = jsonBody.error || 'server_error';
            const message = jsonBody.error_description || 'Get auth code for user with Kong failed: ' + utils.getText(body);
            const statusCode = res.statusCode || 500;
            return failOAuth(statusCode, error, message, callback);
        }
        debug('Kong authorize response:');
        debug(JSON.stringify(jsonBody));
        return callback(null, jsonBody);
    });
}

// -----------------------------------
// GENERIC HELPER METHODS
// -----------------------------------

function lookupSubscription(oauthInfo: OAuthInfo, callback: OAuthInfoCallback) {
    debug('lookupSubscription()');
    wicked.apiGet('subscriptions/' + oauthInfo.inputData.client_id, function (err, subscription) {
        if (err)
            return failOAuth(403, 'unauthorized_client', 'invalid client_id', err, callback);

        const subsInfo = subscription.subscription;
        debug('subsInfo:');
        debug(subsInfo);
        const appInfo = subscription.application;
        debug('appInfo:');
        debug(appInfo);
        // Validate that the subscription is for the correct API
        if (oauthInfo.inputData.api_id !== subsInfo.api) {
            debug('inputData:');
            debug(oauthInfo.inputData);
            debug('subInfo:');
            debug(subsInfo);
            return failOAuth(403, 'unauthorized_client', 'subscription does not match client_id, or invalid api_id', callback);
        }
        oauthInfo.subsInfo = subsInfo;
        oauthInfo.appInfo = appInfo;
        return callback(null, oauthInfo);
    });
}

const _oauth2Configs = {};
function getOAuth2Config(oauthInfo: OAuthInfo, callback: OAuthInfoCallback) {
    debug('getOAuth2Config() for ' + oauthInfo.inputData.api_id);
    const apiId = oauthInfo.inputData.api_id;
    if (_oauth2Configs[apiId]) {
        oauthInfo.oauth2Config = _oauth2Configs[apiId];
        oauthInfo.provisionKey = oauthInfo.oauth2Config.provision_key;
        return callback(null, oauthInfo);
    }

    // We haven't seen this API yet, get it from le Kong.
    kongUtils.kongGet('apis/' + apiId + '/plugins?name=oauth2', function (err, body) {
        if (err)
            return failOAuth(500, 'server_error', 'could not retrieve oauth2 plugins from Kong', err, callback);
        if (body.data.length <= 0)
            return failOAuth(500, 'server_error', `api ${apiId} is not configured for use with oauth2`, callback);
        const oauth2Plugin = body.data[0];
        if (!oauth2Plugin.config.provision_key)
            return failOAuth(500, 'server_error', `api ${apiId} does not have a valid provision_key`, callback);
        // Looks good, remember dat thing
        oauthInfo.oauth2Config = oauth2Plugin.config;
        oauthInfo.provisionKey = oauth2Plugin.config.provision_key;
        _oauth2Configs[apiId] = oauth2Plugin.config;
        callback(null, oauthInfo);
    });
}

// This is a really interesting little function, but I just don't get anymore what it
// was needed for. I think it actually *isn't* needed. But let's keep it in here for
// a little while and see whether the need pops up again...
// 
// function lookupConsumer(oauthInfo, callback) {
//     const customId = oauthInfo.subsInfo.id;
//     debug('lookupConsumer() for subscription ' + customId);
//
//     kongUtils.kongGet('consumers?custom_id=' + qs.escape(customId), function (err, consumer) {
//         if (err) {
//             return failOAuth(500, 'server_error', `could not retrieve consumer for custom id ${customId}`, err, callback);
//         }
//
//         debug('Found these consumers for subscription ' + customId);
//         debug(consumer);
//
//         if (!consumer.total ||
//             consumer.total <= 0 ||
//             !consumer.data ||
//             consumer.data.length <= 0) {
//             return failOAuth(500, 'server_error', `list of consumers for custom id ${customId} either not returned or empty`, callback);
//         }
//
//         oauthInfo.consumer = consumer.data[0];
//         callback(null, oauthInfo);
//     });
// }

const _kongApis: { [apiId: string]: KongApi } = {};
function getKongApi(apiId: string, callback: KongApiCallback) {
    debug(`getKongApi(${apiId})`);
    if (_kongApis[apiId])
        return callback(null, _kongApis[apiId]);
    kongUtils.kongGet('apis/' + apiId, function (err, apiData) {
        if (err)
            return callback(err);
        _kongApis[apiId] = apiData;
        return callback(null, apiData);
    });
}

const _portalApis: { [apiId: string]: WickedApi } = {};
function getPortalApi(apiId, callback: WickedApiCallback): void {
    debug(`getPortalApi(${apiId})`);
    if (_portalApis[apiId])
        return callback(null, _portalApis[apiId]);
    wicked.apiGet('apis/' + apiId, function (err, apiData) {
        if (err)
            return callback(err);
        _portalApis[apiId] = apiData;
        return callback(null, apiData);
    });
}

function lookupApi(oauthInfo: OAuthInfo, callback: OAuthInfoCallback): void {
    const apiId = oauthInfo.subsInfo.api;
    debug('lookupApi() for API ' + apiId);
    async.parallel({
        kongApi: callback => getKongApi(apiId, callback),
        portalApi: callback => getPortalApi(apiId, callback)
    }, function (err, results) {
        if (err) {
            return failOAuth(500, 'server_error', 'could not retrieve API information from API or kong', err, callback);
        }
        const apiInfo = results.kongApi as KongApi;
        const portalApiInfo = results.portalApi as WickedApi;

        if (!apiInfo.uris) {
            return failOAuth(500, 'server_error', `api ${apiId} does not have a valid uris setting`, callback);
        }

        // We will have a specified auth_method, as it's mandatory, now check which auth methods are
        // allowed for the API. This is mandatory for the API.
        if (!portalApiInfo.authMethods)
            return failOAuth(500, 'server_error', `api ${apiId} does not have any authMethods configured`, callback);
        const authMethod = oauthInfo.inputData.auth_method;
        debug(`lookupApi: Matching auth method ${authMethod} against API ${apiId}`);
        const foundMethod = portalApiInfo.authMethods.find(m => m === authMethod);
        if (!foundMethod)
            return failOAuth(500, 'unauthorized_client', `auth method ${authMethod} is not allowed for api ${apiId}`, callback);
        debug(`lookupApi: Auth method ${authMethod} is fine`);

        oauthInfo.apiInfo = apiInfo;
        return callback(null, oauthInfo);
    });
}

function buildKongUrl(apiUrl: string, requestPath: string, additionalPath: string): string {
    let hostUrl = apiUrl;
    let reqPath = requestPath;
    let addPath = additionalPath;
    if (!hostUrl.endsWith('/'))
        hostUrl = hostUrl + '/';
    if (reqPath.startsWith('/'))
        reqPath = reqPath.substring(1); // cut leading /
    if (!reqPath.endsWith('/'))
        reqPath = reqPath + '/';
    if (addPath.startsWith('/'))
        addPath = addPath.substring(1); // cut leading /
    return hostUrl + reqPath + addPath;
}

// module.exports = oauth2;
