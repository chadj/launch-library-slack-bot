const moment = require('moment-timezone');
const request = require('request-promise-native');
const querystring = require('querystring');
const DynamoDB = require('aws-sdk/clients/dynamodb');
const settings = require('./settings');
const templates = require('./templates');

async function endpoint(event, context, callback) {
    if (event.httpMethod === 'GET' && event.queryStringParameters && event.queryStringParameters.code) {
        // Is this request related to OAuth for the app itself or a user?
        await oauthAuthorize(event, context, callback);
    } else {
        // Is this request related to setting a reminder or responding to a slack command?
        await slackAction(event, context, callback);
    }
}

async function oauthAuthorize(event, context, callback) {
    const code = event.queryStringParameters.code;

    let qs = {
        client_id: settings.SLACK_CLIENT_ID,
        client_secret: settings.SLACK_CLIENT_SECRET,
        code: code
    };
    const body = await request({
        method: 'GET',
        uri: 'https://slack.com/api/oauth.access',
        qs: qs,
        json: true,
    });

    if (!body.ok) {
        // OAuth Failure
        let response = {
            statusCode: 200,
            headers: {
                'Content-Type': 'text/html; charset=utf-8'
            },
            body: templates.oauth_failure(body.error)
        };
        callback(null, response);
    } else {
        // Successful oauth authorization
        const dynamodb = new DynamoDB();
        if (body.bot) {
            // Branch for handling successful installation of app into workspace
            await dynamodb.putItem({
                Item: {
                    team_id: {
                        S: body.team_id
                    },
                    access_token: {
                        S: body.access_token
                    },
                    user_id: {
                        S: body.user_id
                    },
                    team_name: {
                        S: body.team_name
                    },
                    bot_user_id: {
                        S: body.bot.bot_user_id
                    },
                    bot_access_token: {
                        S: body.bot.bot_access_token
                    }
                },
                TableName: 'launch_library_team'
            }).promise();

            let slack_msg = {
                channel: body.user_id,
                text: "Hello and thanks for installing me.  To enroll a channel in daily launch notifications issue the following slack command from within the desired channel: `/launch_library_subscribe 13`.  Where the number 13 is the hour of the day, in UTC, to receive notifications."
            };
            const message_body = await request({
                method: 'POST',
                uri: 'https://slack.com/api/chat.postMessage',
                headers: {
                    'Authorization': `Bearer ${body.bot.bot_access_token}`,
                    'Content-Type': 'application/json; charset=utf-8'
                },
                json: slack_msg,
            });

            let response = {
                statusCode: 200,
                headers: {
                    'Content-Type': 'text/html; charset=utf-8'
                },
                body: templates.bot_install_success()
            };
            callback(null, response);
        } else {
            // Branch for handling successful authorization of reminders access
            const user = JSON.parse(event.queryStringParameters.state);
            await dynamodb.putItem({
                Item: {
                    user_id: {
                        S: user.user_id
                    },
                    oauth_access_token: {
                        S: body.access_token
                    },
                    user_name: {
                        S: user.user_name
                    },
                    team_id: {
                        S: body.team_id
                    },
                    team_name: {
                        S: body.team_name
                    }
                },
                TableName: 'launch_library_users'
            }).promise();

            let response = {
                statusCode: 200,
                headers: {
                    'Content-Type': 'text/html; charset=utf-8'
                },
                body: templates.reminder_access_success()
            };
            callback(null, response);
        }
    }
}

async function slackAction(event, context, callback) {
    const dynamodb = new DynamoDB();
    const body = querystring.parse(event.body)
    let action = body.payload ? JSON.parse(body.payload) : undefined;

    let resp_msg;
    if (action) {
        // This request relates to setting an actual reminder for a launch
        if (action.token !== settings.VERIFICATION_TOKEN) {
            resp_msg = failureResponse('API Verification error');
        } else {
            let launch_id = action.callback_id;
            const team_id = action.team.id;
            const user_id = action.user.id;
            const user_name = action.user.name;

            const d_resp = await dynamodb.getItem({
                Key: {
                    user_id: {
                        S: user_id
                    }
                },
                TableName: 'launch_library_users'
            }).promise();

            let user_oauth_access_token;
            if (d_resp.Item && d_resp.Item.oauth_access_token) {
                user_oauth_access_token = d_resp.Item.oauth_access_token.S;
            }

            if (user_oauth_access_token) {
                let type = 'launch';
                if(launch_id.startsWith('event-')) {
                    type = 'event';
                    launch_id = launch_id.replace('event-', '');
                }

                let launch;
                let watch_fmt;
                let reminder_fmt;
                let reminder_unx;
                if(type === 'launch') {
                    launch = await request({
                        method: 'GET',
                        uri: `https://ll.thespacedevs.com/2.0.0/launch/${launch_id}/`,
                        qs: {
                            format: 'json'
                        },
                        gzip: true,
                        headers: {
                            'User-Agent': settings.USER_AGENT
                        },
                        json: true
                    });

                    const reminder_date = new Date(launch.window_start);
                    reminder_date.setMinutes(reminder_date.getMinutes() - 10);
                    const reminder = moment(reminder_date).tz(settings.SLACK_TZ_NAME);
                    reminder_fmt = reminder.format("M/D h:mm A zz");
                    reminder_unx = reminder_date.getTime() / 1000;

                    watch_fmt = "";
                    if (launch.vidURLs) {
                        const vids = [];
                        for (const [idx, u] of launch.vidURLs.entries()) {
                            let txt_extra = "";
                            if (launch.vidURLs.length > 1) {
                                txt_extra = ` #${(idx + 1)}`;
                            }
                            vids.push(`<${u.url}|live stream${txt_extra}>`);
                        }
                        watch_fmt = `  Watch it! ${vids.join(', ')}`;
                    }
                } else if(type === 'event') {
                    launch = await request({
                        method: 'GET',
                        uri: `https://ll.thespacedevs.com/2.0.0/event/${launch_id}/`,
                        qs: {
                            format: 'json'
                        },
                        gzip: true,
                        headers: {
                            'User-Agent': settings.USER_AGENT
                        },
                        json: true
                    });

                    const reminder_date = new Date(launch.date);
                    reminder_date.setMinutes(reminder_date.getMinutes() - 10);
                    const reminder = moment(reminder_date).tz(settings.SLACK_TZ_NAME);
                    reminder_fmt = reminder.format("M/D h:mm A zz");
                    reminder_unx = reminder_date.getTime() / 1000;

                    if (launch.video_url) {
                        watch_fmt = `  Watch it! <${launch.video_url}|live stream>`;
                    }
                }

                let slack_msg = {
                    text: `${launch.name} is launching soon!${watch_fmt}.`,
                    time: reminder_unx
                };
                const body = await request({
                    method: 'POST',
                    uri: 'https://slack.com/api/reminders.add',
                    headers: {
                        'Authorization': `Bearer ${user_oauth_access_token}`,
                        'Content-Type': 'application/json; charset=utf-8'
                    },
                    json: slack_msg,
                });

                if (!body.ok) {
                    if (body.error === "token_revoked" || body.error === "invalid_auth" || body.error === "account_inactive") {
                        const d_resp = await dynamodb.deleteItem({
                            Key: {
                                user_id: {
                                    S: user_id
                                }
                            },
                            TableName: 'launch_library_users'
                        }).promise();

                        resp_msg = oauthAuthorizeResponse(user_id, user_name, team_id);
                    } else {
                        throw new Error(`Slack reminders.add error: ${JSON.stringify(slack_msg)}\n\n${JSON.stringify(body, false, null)}\n\n`);
                    }
                } else {
                    resp_msg = {
                        response_type: 'ephemeral',
                        replace_original: false,
                        text: `Reminder for ${launch.name} set for <!date^${reminder_unx}^{date_short_pretty} at {time}|${reminder_fmt}>`
                    };
                }
            } else {
                resp_msg = oauthAuthorizeResponse(user_id, user_name, team_id);
            }
        }
    } else {
        if (body.command) {
            // This request handles the enrollment of a channel onto daily launch notifications
            if (body.token !== settings.VERIFICATION_TOKEN) {
                resp_msg = failureResponse('API Verification error');
            } else {
                if (body.command === '/launch_library_subscribe') {
                    let [time_of_day, ...rest] = body.text.split(/\s+/);

                    if (time_of_day !== undefined && time_of_day !== null && time_of_day !== '') {
                        if (time_of_day.includes(':')) {
                            [time_of_day, ...rest] = time_of_day.split(':');
                        }
                        time_of_day = parseInt(time_of_day);

                        if (time_of_day >= 0 && time_of_day < 24) {
                            await dynamodb.putItem({
                                Item: {
                                    channel_id: {
                                        S: body.channel_id
                                    },
                                    channel_name: {
                                        S: body.channel_name
                                    },
                                    team_id: {
                                        S: body.team_id
                                    },
                                    team_domain: {
                                        S: body.team_domain
                                    },
                                    user_id: {
                                        S: body.user_id
                                    },
                                    user_name: {
                                        S: body.user_name
                                    },
                                    time_of_day: {
                                        N: time_of_day.toString()
                                    }
                                },
                                TableName: 'launch_library_channel'
                            }).promise();

                            resp_msg = {
                                text: `Launch Library Bot successfully enrolled on channel ${body.channel_name} for notification at ${time_of_day}:00 UTC`
                            };
                        } else {
                            resp_msg = {
                                "attachments": [{
                                    "text": "The time of day argument must be an hour between 0 and 23",
                                    "color": "#a94442"
                                }]
                            };
                        }
                    } else {
                        resp_msg = {
                            "attachments": [{
                                "text": "Please specify one argument to the /launch_library_subscribe command.  Example: /launch_library_subscribe 13",
                                "color": "#a94442"
                            }]
                        };
                    }
                } else if (body.command === '/launch_library_unsubscribe') {
                    const d_resp = await dynamodb.deleteItem({
                        Key: {
                            channel_id: {
                                S: body.channel_id
                            }
                        },
                        TableName: 'launch_library_channel'
                    }).promise();

                    resp_msg = {
                        text: `Launch Library Bot successfully withdrew channel ${body.channel_name} from notifications`
                    };
                }
            }
        } else {
            // This is an SSL keep-alive request from Slack
            resp_msg = {};
        }
    }

    let response = {
        statusCode: 200,
        headers: {
            'Content-Type': 'application/json; charset=utf-8'
        },
        body: JSON.stringify(resp_msg)
    };

    callback(null, response);
}

function failureResponse(msg) {
    resp_msg = {
        response_type: 'ephemeral',
        replace_original: false,
        text: msg
    }

    return resp_msg;
}

function oauthAuthorizeResponse(user_id, user_name, team_id) {
    const user = JSON.stringify({
        user_id,
        user_name
    });
    const oauth_authorize_url = `https://slack.com/oauth/authorize?team=${encodeURIComponent(team_id)}&client_id=${encodeURIComponent(settings.SLACK_CLIENT_ID)}&scope=${encodeURIComponent(settings.SLACK_SCOPE)}&state=${encodeURIComponent(user)}`;

    resp_msg = {
        response_type: 'ephemeral',
        replace_original: false,
        attachments: [{
            "color": "#800000",
            "title": "Launch Library Bot needs your approval to send reminders.",
            "fallback": "Launch Library Bot needs your approval to send reminders.",
            "actions": [{
                "type": "button",
                "text": `Grant Access`,
                "fallback": `Grant Access`,
                "url": oauth_authorize_url
            }]
        }]
    }

    return resp_msg;
}

exports.endpoint = endpoint;
