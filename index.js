const moment = require('moment-timezone');
const request = require('request-promise-native');
const querystring = require('querystring');
const AWS = require('aws-sdk/global');
const DynamoDB = require('aws-sdk/clients/dynamodb');

const settings = require('./settings');

AWS.config.accessKeyId = settings.AWS_ACCCESS_KEY_ID;
AWS.config.secretAccessKey = settings.AWS_SECRET_ACCESS_KEY;
AWS.config.region = settings.AWS_REGION;

function imgUrlChoose(baseurl, versions) {
  if (baseurl.includes('placeholder')) {
    return '';
  }
  let url_split = baseurl.split('_');
  let size_extension = url_split.pop();
  let size_extension_split = size_extension.split('.');
  let extension = size_extension_split.pop();
  let size = versions[1];

  let url = url_split.join('_') + '_' + size + '.' + extension;

  return url;
}

async function handleMessages(channel_id, bot_access_token, messages) {
  for (const message of messages) {
    let slack_msg = {
      channel: channel_id,
      text: message.text,
      attachments: message.attachments,
      unfurl_links: false,
      unfurl_media: true,
    };
    const body = await request({
      method: 'POST',
      uri: 'https://slack.com/api/chat.postMessage',
      headers: {
        'Authorization': `Bearer ${bot_access_token}`,
        'Content-Type': 'application/json; charset=utf-8'
      },
      json: slack_msg,
    });

    if (!body.ok) {
      throw new Error(`Slack chat.postMessage error: ${JSON.stringify(slack_msg)}\n\n${JSON.stringify(body, false, null)}`);
    }
  }
}

async function pollForLaunches(event, context, callback) {
  const now = new Date();
  let current_time_of_day = now.getUTCHours();

  const dynamodb = new DynamoDB();
  const d_resp = await dynamodb.query({
    ExpressionAttributeValues: {
      ':time_of_day': { N: current_time_of_day.toString() }
    },
    KeyConditionExpression: 'time_of_day = :time_of_day',
    IndexName: 'time_of_day-index',
    TableName: 'launch_library_channel'
  }).promise();

  const errors = [];
  if(d_resp.Count > 0) {
    const manifest = await request({
      method: 'GET',
      uri: 'https://launchlibrary.net/1.4/launch',
      qs: {
        mode: 'verbose'
      },
      gzip: true,
      headers: {
        'User-Agent': settings.USER_AGENT
      },
      json: true
    });

    const cutoff_start = new Date();
    const cutoff_end = new Date(cutoff_start);
    cutoff_end.setDate(cutoff_end.getDate() + 1);

    const messages = [];

    for (const launch of manifest.launches) {
      if (!launch.windowstart) {
        return;
      }

      const window_start_date = new Date(launch.windowstart);
      let window_endtest_date;
      if (launch.windowend) {
        window_endtest_date = new Date(launch.windowend);
      } else {
        window_endtest_date = window_start_date;
      }
      if (launch.tbdtime === 0 && ((window_start_date >= cutoff_start && window_start_date < cutoff_end) ||
          (window_endtest_date >= cutoff_start && window_endtest_date < cutoff_end))) {
        // Launch today
        const window_start = moment(window_start_date).tz(settings.SLACK_TZ_NAME);
        const window_start_fmt = window_start.format("M/D h:mm A zz");
        const window_start_unx = launch.wsstamp;

        let window_end;
        let window_end_fmt;
        let window_end_unx;
        if (launch.windowend) {
          window_end = moment(new Date(launch.windowend)).tz(settings.SLACK_TZ_NAME);
          window_end_fmt = window_end.format("M/D h:mm A zz");
          window_end_unx = launch.westamp;
        }

        let net;
        let net_fmt;
        let net_unx;
        if (launch.net) {
          net = moment(new Date(launch.net)).tz(settings.SLACK_TZ_NAME);
          net_fmt = net.format("M/D h:mm A zz");
          net_unx = launch.netstamp;
        }

        const name_extra = [];
        if (launch.rocket && launch.rocket.wikiURL) {
          name_extra.push(`<${launch.rocket.wikiURL}|rocket>`);
        }

        if (launch.missions) {
          let missions = launch.missions.filter(function(m) {
            return !!m.wikiURL
          });
          for (const [idx, m] of missions.entries()) {
            let mission_num = "";
            if (missions.length > 1) {
              mission_num = ` ${(idx + 1)}`;
            }
            name_extra.push(`<${m.wikiURL}|mission${mission_num}>`);
          };
        }

        let name_extra_fmt = "";
        if (name_extra.length > 0) {
          name_extra_fmt = ` (${name_extra.join(", ")})`;
        }

        let message = `*${launch.name}*${name_extra_fmt}\n`;
        if (net_unx) {
          message += `T-0: <!date^${net_unx}^{date_short_pretty} at {time}|${net_fmt}>\n`;
        }
        if (launch.probability && launch.probability !== -1) {
          message += `Weather: ${launch.probability}% go\n`;
        }
        if (window_start_unx) {
          if (window_start_unx && window_end_unx && window_start_unx !== window_end_unx) {
            message += `Window: <!date^${window_start_unx}^{date_short_pretty} at {time}|${window_start_fmt}> - <!date^${window_end_unx}^{date_short_pretty} at {time}|${window_end_fmt}>\n`;
          } else {
            message += `Window: <!date^${window_start_unx}^{date_short_pretty} at {time}|${window_start_fmt}>\n`;
          }
        }
        if (launch.location && launch.location.pads && launch.location.pads.length > 0 && launch.location.pads[0].name) {
          const launch_extra = [];
          if (launch.location.pads[0].wikiURL) {
            launch_extra.push(`<${launch.location.pads[0].wikiURL}|wiki>`);
          }
          if (launch.location.pads[0].mapURL) {
            launch_extra.push(`<${launch.location.pads[0].mapURL}|map>`);
          }
          let lauch_extra_fmt = "";
          if (launch_extra.length > 0) {
            lauch_extra_fmt = ` (${launch_extra.join(", ")})`;
          }
          message += `${launch.location.pads[0].name}${lauch_extra_fmt}\n`;
        }
        if (launch.missions) {
          for (const mission of launch.missions) {
            message += `\n${mission.description}\n`;
          }
        }

        if (launch.rocket && launch.rocket.imageURL) {
          const imgUrl = imgUrlChoose(launch.rocket.imageURL, launch.rocket.imageSizes);
          if (imgUrl) {
            message += `\n<${imgUrl}|:rocket:>\n`;
          }
        }

        const attachments = [];
        const actions = [];

        actions.push({
          name: "remind",
          text: "Remind Me",
          type: "button",
          value: launch.id
        });

        if (launch.vidURLs) {
          for (const [idx, u] of launch.vidURLs.entries()) {
            let txt_extra = "";
            if (launch.vidURLs.length > 1) {
              txt_extra = ` #${(idx + 1)}`;
            }
            actions.push({
              "type": "button",
              "text": `Watch Live${txt_extra}`,
              "fallback": `Watch it live at ${u}`,
              "url": u
            });
          }
        }

        attachments.push({
          "color": "#005883",
          "fallback": "Launch Actions",
          "callback_id": launch.id,
          "actions": actions
        });

        const msg = {
          text: message,
          attachments: attachments
        }

        messages.push(msg);
      }
    }

    for(const item of d_resp.Items) {
      try {
        const channel_id = item.channel_id.S;
        const team_id = item.team_id.S;

        const t_resp = await dynamodb.getItem({
          Key: {
            team_id: {
              S: team_id
            }
          },
          TableName: 'launch_library_team'
        }).promise();

        await handleMessages(channel_id, t_resp.Item.bot_access_token.S, messages);
      } catch(error) {
        errors.push(error);
      }
    }
  }

  if(errors.length) {
    console.error(errors);
    callback(errors);
  } else {
    console.log(`done ${d_resp.Count}`);
    context.done();
  }
}

async function apiGateway(event, context, callback) {
  if (event.httpMethod === 'GET' && event.queryStringParameters && event.queryStringParameters.code) {
    await oauthAuthorize(event, context, callback);
  } else {
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
    let response = {
      statusCode: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8'
      },
      body: `
      <html lang="en">
      <head>
        <meta charset="utf-8">
        <title>Launch Library Bot - Authorization Failure</title>
        <link href="https://fonts.googleapis.com/css?family=Sunflower:300" rel="stylesheet">
      </head>
      <body style="font-family: 'Sunflower', sans-serif;">
        <h1>Error</h1>
        Unable to grant access: ${body.error}
      </body>
      </html>
      `
    };
    callback(null, response);
  } else {
    const dynamodb = new DynamoDB();
    if (body.bot) {
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
        body: `
          <html lang="en">
          <head>
            <meta charset="utf-8">
            <title>Launch Library Bot - Application Installation Success</title>
            <link href="https://fonts.googleapis.com/css?family=Sunflower:300" rel="stylesheet">
          </head>
          <body style="font-family: 'Sunflower', sans-serif;">
            <h1>Success</h1>
            Launch Library Bot has been successfully installed.  You may now close this tab and return to Slack.
          </body>
          </html>
          `
      };
      callback(null, response);
    } else {
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
        body: `
          <html lang="en">
          <head>
            <meta charset="utf-8">
            <title>Launch Library Bot - Authorization Success</title>
            <link href="https://fonts.googleapis.com/css?family=Sunflower:300" rel="stylesheet">
          </head>
          <body style="font-family: 'Sunflower', sans-serif;">
            <h1>Success</h1>
            Launch Library Bot can now set reminders for you.  You may close this tab and attempt to set a reminder for a launch in Slack.
          </body>
          </html>
          `
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
    if (action.token !== settings.VERIFICATION_TOKEN) {
      resp_msg = failureResponse('API Verification error');
    } else {
      const launch_id = action.callback_id;
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
        const manifest = await request({
          method: 'GET',
          uri: `https://launchlibrary.net/1.4/launch/${launch_id}`,
          gzip: true,
          headers: {
            'User-Agent': settings.USER_AGENT
          },
          json: true
        });

        const launch = manifest.launches[0];
        const reminder_date = new Date(launch.windowstart);
        reminder_date.setMinutes(reminder_date.getMinutes() - 10);
        const reminder = moment(reminder_date).tz(settings.SLACK_TZ_NAME);
        const reminder_fmt = reminder.format("M/D h:mm A zz");
        const reminder_unx = reminder_date.getTime() / 1000;

        let watch_fmt = "";
        if (launch.vidURLs) {
          const vids = [];
          for (const [idx, u] of launch.vidURLs.entries()) {
            let txt_extra = "";
            if (launch.vidURLs.length > 1) {
              txt_extra = ` #${(idx + 1)}`;
            }
            vids.push(`<${u}|live stream${txt_extra}>`);
          }
          watch_fmt = `  Watch it! ${vids.join(', ')}`;
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
      if (body.token !== settings.VERIFICATION_TOKEN) {
        resp_msg = failureResponse('API Verification error');
      } else {
        let [time_of_day, ...rest] = body.text.split(/\s+/);

        if (time_of_day !== undefined && time_of_day !== null && time_of_day !== '') {
          if (time_of_day.includes(':')) {
            [time_of_day, ...rest] = time_of_day.split(':');
          }
          time_of_day = parseInt(time_of_day);

          if(time_of_day >= 0 && time_of_day < 24) {
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
      }
    } else {
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

exports.handler = function(event, context, callback) {
  if (event.source === "aws.events") {
    pollForLaunches(event, context, callback).catch(err => {
      console.error(err);
      callback(err);
    });
  } else {
    console.log(event, context);
    apiGateway(event, context, callback).catch(err => {
      console.error(err);
      callback(err);
    });
  }
};
