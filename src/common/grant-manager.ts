'use strict';

import { utils } from './utils';
import { ExpressHandler } from './types';
import { WickedGrantCollection, WickedApplication, WickedUserInfo, WickedApi, WickedGrant } from './wicked-types';
import { failMessage, failError } from './utils-fail';
const { debug, info, warn, error } = require('portal-env').Logger('portal-auth:grant-manager');
const Router = require('express').Router;
const qs = require('querystring');
const wicked: any = require('wicked-sdk');
import * as async from 'async';

interface ShortInfo {
    id: string,
    name: string
}

interface ExtendedGrant extends WickedGrant {
    // userInfo: WickedUserInfo,
    apiInfo: ShortInfo,
    appInfo: ShortInfo
}

interface ExtendedGrantListCallback {
    (err, extendedGrantList?: ExtendedGrant[]): void
}

enum FlashType {
    Error = "error",
    Warning = "warning",
    Success = "success"
}

interface FlashMessage {
    type: FlashType,
    message: string
}

export class GrantManager {

    private authMethodId: string;
    private router: any;

    constructor(authMethodId: string) {
        debug(`constructor(${authMethodId})`);
        this.authMethodId = authMethodId;

        this.router = new Router();

        this.router.get('/', this.renderUserScopes);
        this.router.post('/', this.revokeUserScope);
    }

    public getRouter() {
        return this.router;
    }

    private renderUserScopes = (req, res, next) => {
        return this.renderUserScopesWithMessage(req, res, next, null);
    }

    private renderUserScopesWithMessage(req, res, next, flashMessage: FlashMessage) {
        debug(`renderUserScopes(${this.authMethodId})`);
        const instance = this;
        // If not logged in, make sure the user logs in, and the redirect back here
        if (!utils.isLoggedIn(req, this.authMethodId))
            return utils.loginAndRedirectBack(req, res, this.authMethodId);

        const authResponse = utils.getAuthResponse(req, this.authMethodId);
        const userId = authResponse.userId;

        debug(`renderUserScopes: Getting user ${userId} grant collection`);
        wicked.apiGet(`/grants/${userId}`, function (err, userGrants: WickedGrantCollection) {
            if (err)
                return failError(500, err, next);
            debug(`renderUserScopes: Successfully retrieved user grants.`)

            appendAppAndApiInfo(userGrants, function (err, extendedGrantList) {
                if (err)
                    return failError(500, err, next);

                const viewModel = utils.createViewModel(req, instance.authMethodId);
                viewModel.grants = extendedGrantList;
                if (flashMessage)
                    viewModel.flashMessage = flashMessage

                res.render('scope_list', viewModel);
            });
        });
    }

    private revokeUserScope: ExpressHandler = (req, res, next) => {
        debug(`revokeUserScope(${this.authMethodId})`);
        const instance = this;
        // If not logged in, redirect to this URL, but using GET
        if (!utils.isLoggedIn(req, this.authMethodId))
            return utils.loginAndRedirectBack(req, res, this.authMethodId);

        const body = req.body;
        const csrfToken = body._csrf;
        const expectedCsrfToken = utils.getAndDeleteCsrfToken(req);

        if (!csrfToken || csrfToken !== expectedCsrfToken)
            return this.renderUserScopesWithMessage(req, res, next, { type: FlashType.Error, message: 'Suspected login forging detected (CSRF protection).' });

        const authResponse = utils.getAuthResponse(req, this.authMethodId);
        const userId = authResponse.userId;

        const appId = body.revoke_app;
        const apiId = body.revoke_api;

        if (!appId || !apiId)
            return failMessage(400, 'Invalid request, revoke_app and/or revoke_api not defined.', next);

        wicked.apiDelete(`/grants/${userId}/applications/${appId}/apis/${apiId}`, function (err) {
            if (err && (err.status === 404 || err.statusCode === 404)) {
                // Not found
                return instance.renderUserScopesWithMessage(req, res, next, { type: FlashType.Warning, message: 'Application grant record not found.' });
            } else if (err) {
                // Some other hard error
                return failError(500, err, next);
            }

            return instance.renderUserScopesWithMessage(req, res, next, { type: FlashType.Success, message: `Access of application "${appId}" to API "${apiId}" was successfully revoked.` });
        });
    }
}

function appendAppAndApiInfo(userGrants: WickedGrantCollection, callback: ExtendedGrantListCallback) {
    debug(`appendAppAndApiInfo()`);
    const grantList: ExtendedGrant[] = [];
    async.each(userGrants.items, (userGrant: WickedGrant, callback) => {
        async.parallel({
            appInfo: callback => wicked.apiGet(`/applications/${userGrant.applicationId}`, function (err, appInfo: WickedApplication) {
                if (err)
                    return callback(null, { id: userGrant.applicationId, name: '(Unknown or invalid application)' })
                return callback(null, { id: userGrant.applicationId, name: appInfo.name });
            }),
            apiInfo: callback => utils.getApiInfo(userGrant.apiId, function (err, apiInfo) {
                if (err)
                    return callback(null, { id: userGrant.apiId, name: '(Unknown or invalid API)' });
                return callback(null, { id: userGrant.apiId, name: apiInfo.name });
            })
        }, function (err, results) {
            if (err)
                return failError(500, err, callback);

            const extendedGrant = {
                ...userGrant,
                apiInfo: results.apiInfo as ShortInfo,
                appInfo: results.appInfo as ShortInfo
            };
            grantList.push(extendedGrant);
            return callback(null);
        })
    }, (err) => {
        if (err)
            return failError(500, err, callback);
        return callback(null, grantList);
    });
}