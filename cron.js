const moment = require('moment-timezone');
const request = require('request-promise-native');
const DynamoDB = require('aws-sdk/clients/dynamodb');
const settings = require('./settings');

async function poll(event, context, callback) {
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

exports.poll = poll;
