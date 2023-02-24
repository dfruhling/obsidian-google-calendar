/* eslint-disable @typescript-eslint/no-var-requires */


/*
	This file is used to authenticate the user to the google google cloud service 
	and refresh the access token if needed 
*/


import type { IncomingMessage, ServerResponse } from 'http';

import GoogleCalendarPlugin from './../GoogleCalendarPlugin';
import {
	settingsAreComplete,
	settingsAreCompleteAndLoggedIn,
} from "../view/GoogleCalendarSettingTab";
import {
	getAccessToken,
	getExpirationTime,
	getRefreshToken,
	setAccessToken,
	setExpirationTime,
	setRefreshToken,
} from "../helper/LocalStorage";
import { Notice, Platform, requestUrl } from "obsidian";
import { createNotice } from 'src/helper/NoticeHelper';
import * as crypto from "crypto";



const PORT = 42813;
const REDIRECT_URL = `http://localhost:${PORT}/callback`;
const PUBLIC_CLIENT_ID = `783376961232-v90b17gr1mj1s2mnmdauvkp77u6htpke.apps.googleusercontent.com`

let lastRefreshTryMoment = window.moment().subtract(100, "seconds");
let authSession = {runningHTTPServer: null, verifier: null, challenge: null, state:null};

// Creates a code verifier for the OAuth flow
function base64URLEncode(str) {
	return str.toString('base64')
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=/g, '');
}

// Creates a code challenge for the OAuth flow
function sha256(buffer) {
	return crypto.createHash('sha256').update(buffer).digest();
}

export function getAccessIfValid(): string {
	//Check if the token exists
	if (!getAccessToken() || getAccessToken() == "") return;

	//Check if Expiration time is not set or default 0
	if (!getExpirationTime()) return;

	//Check if Expiration time is set to text
	if (isNaN(getExpirationTime())) return

	//Check if Expiration time is in the past so the token is expired
	if (getExpirationTime() < +new Date()) return;

	return getAccessToken();
}


const refreshAccessToken = async (plugin: GoogleCalendarPlugin): Promise<string> => {
	const useCustomClient = plugin.settings.useCustomClient;

	// if(lastRefreshTryMoment.diff(window.moment(), "seconds") < 60){
	// 	return;
	// }

	let refreshBody = {
		grant_type: "refresh_token",
		client_id: useCustomClient ? plugin.settings.googleClientId?.trim() : PUBLIC_CLIENT_ID,
		client_secret: useCustomClient ? plugin.settings.googleClientSecret?.trim() : null,
		refresh_token: getRefreshToken(),
	};

	const {json: tokenData} = await requestUrl({
		method: 'POST',
		url: useCustomClient ? `https://oauth2.googleapis.com/token` : `${plugin.settings.googleOAuthServer}/api/google/refresh`,
		headers: {'content-type': 'application/json'},
		body: JSON.stringify(refreshBody)
	})
	
	if (!tokenData) {
		createNotice("Error while refreshing authentication");
		return;
	}
	
	//Save new Access token and Expiration Time
	setAccessToken(tokenData.access_token);
	setExpirationTime(+new Date() + tokenData.expires_in * 1000);
	return tokenData.access_token;
}

const exchangeCodeForTokenDefault = async (plugin: GoogleCalendarPlugin, state:string, verifier:string, code: string): Promise<boolean> => {

	const request = await requestUrl({
		method: 'POST',
		url: `${plugin.settings.googleOAuthServer}/api/google/token`,
		headers: {'content-type': 'application/json'},
		body: JSON.stringify({
			"client_id": PUBLIC_CLIENT_ID,
			"code_verifier": verifier,
			"code": code,
			"state": state,
		})
	})

	return request.json;
}

const exchangeCodeForTokenCustom = async (plugin: GoogleCalendarPlugin, state: string, verifier:string, code: string): Promise<boolean> => {
	const url = `https://oauth2.googleapis.com/token`
	+ `?grant_type=authorization_code`
	+ `&client_id=${plugin.settings.googleClientId?.trim()}`
	+ `&client_secret=${plugin.settings.googleClientSecret?.trim()}`
	+ `&code_verifier=${verifier}`
	+ `&code=${code}`
	+ `&state=${state}`
	+ `&redirect_uri=http://localhost:42813/callback`

	const response = await requestUrl({
		url,
		method: 'POST',
		headers: {'content-type': 'application/x-www-form-urlencoded'},
	});

	return await response.json;
}

/**
 * Function the get the access token used in every request to the Google Calendar API
 * 
 * Function will check if a access token exists and if its still valid
 * if not it will request a new access token using the refresh token
 * 
 * @returns A valid access Token
 */
export async function getGoogleAuthToken(plugin: GoogleCalendarPlugin): Promise<string> {
	// Check if refresh token is set
	if (!settingsAreCompleteAndLoggedIn()) return;

	let accessToken = getAccessIfValid();

	//Check if the Access token is still valid or if it needs to be refreshed
	if (!accessToken) {
		accessToken = await refreshAccessToken(plugin);		
	}

	// Check if refresh of access token did non work
	if(!accessToken)return

	return accessToken;
}

/**
 * Function to allow the user to grant the APplication access to his google calendar by OAUTH authentication
 * 
 * Function will start a local server 
 * User is redirected to OUATh screen
 * If authentication is successfully user is redirected to local server
 * Server will read the tokens and save it to local storage
 * Local server will shut down
 * 
 */
export async function LoginGoogle(): Promise<void> {
	const plugin = GoogleCalendarPlugin.getInstance();
	const useCustomClient = plugin.settings.useCustomClient;


	const CLIENT_ID = useCustomClient ? plugin.settings.googleClientId : PUBLIC_CLIENT_ID;


	if (Platform.isDesktop) {
		if (!settingsAreComplete()) return;

		const http = require("http");
		const url = require("url");
		const destroyer = require("server-destroy");

		if(!authSession.state){
			authSession.state = base64URLEncode(crypto.randomBytes(32));
			authSession.verifier = base64URLEncode(crypto.randomBytes(32));
			authSession.challenge = base64URLEncode(sha256(authSession.verifier));
		}

		const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth'
		+ `?client_id=${CLIENT_ID}`
		+ `&response_type=code`
		+ `&redirect_uri=${REDIRECT_URL}`
		+ `&prompt=consent`
		+ `&access_type=offline`
		+ `&state=${authSession.state}`
		+ `&code_challenge=${authSession.challenge}`
		+ `&code_challenge_method=S256`
		+ `&scope=email%20profile%20https://www.googleapis.com/auth/calendar`;
		
		// Make sure no server is running before starting a new one
		if(authSession.runningHTTPServer) {
			window.open(authUrl);
			return
		}

		authSession.runningHTTPServer = http.createServer(async (req: IncomingMessage, res: ServerResponse) => {
				if(req.url?.startsWith("/callback")) {
					console.log("Auth server callback", req)
					const qs = new url.URL(
						req.url,
						`${REDIRECT_URL}`
					).searchParams;
					
					const received_state = qs.get("state");
					const code = qs.get("code");

					// Make sure the authentication response is from the same session
					if (received_state !== authSession.state) {
						return;
					}

					let token;
					if(useCustomClient){
						token = await exchangeCodeForTokenCustom(plugin, authSession.state, authSession.verifier, code);
					}else{
						token = await exchangeCodeForTokenDefault(plugin, authSession.state, authSession.verifier, code);
					}

					if(token?.refresh_token) {
						setRefreshToken(token.refresh_token);
						setAccessToken(token.access_token);
						setExpirationTime(+new Date() + token.expires_in * 1000);
					}
					res.end(
						"Authentication successful! Please return to obsidian."
					);
					
					console.info("Tokens acquired.");
					plugin.settingsTab.display();

					destroyer(authSession.runningHTTPServer);
					authSession = {runningHTTPServer: null, verifier: null, challenge: null, state:null};
				}
			})
			.listen(PORT, async () => {
				console.log("Auth server started")
				window.open(authUrl);
			});
	} else {
		new Notice("Can't use OAuth on this device");
	}
}