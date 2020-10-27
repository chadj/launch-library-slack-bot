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
      uri: 'https://ll.thespacedevs.com/2.0.0/launch/upcoming/',
      qs: {
        format: 'json',
        mode: 'detailed',
        limit: '20'
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

    for (const launch of manifest.results) {
      if (!launch.window_start) {
        return;
      }

      const window_start_date = new Date(launch.window_start);
      let window_endtest_date;
      if (launch.window_end) {
        window_endtest_date = new Date(launch.window_end);
      } else {
        window_endtest_date = window_start_date;
      }
      if (!launch.tbdtime && ((window_start_date >= cutoff_start && window_start_date < cutoff_end) ||
          (window_endtest_date >= cutoff_start && window_endtest_date < cutoff_end))) {
        // Launch today
        const window_start = moment(window_start_date).tz(settings.SLACK_TZ_NAME);
        const window_start_fmt = window_start.format("M/D h:mm A zz");
        const window_start_unx = window_start_date.getTime() / 1000;

        let window_end;
        let window_end_fmt;
        let window_end_unx;
        if (launch.window_end) {
          let window_end_date = new Date(launch.window_end);
          window_end = moment(window_end_date).tz(settings.SLACK_TZ_NAME);
          window_end_fmt = window_end.format("M/D h:mm A zz");
          window_end_unx = window_end_date.getTime() / 1000;
        }

        let net;
        let net_fmt;
        let net_unx;
        if (launch.net) {
          let net_date = new Date(launch.net);
          net = moment(net_date).tz(settings.SLACK_TZ_NAME);
          net_fmt = net.format("M/D h:mm A zz");
          net_unx = net_date.getTime() / 1000;
        }

        const name_extra = [];
        if (launch.rocket && launch.rocket.configuration && launch.rocket.configuration.wiki_url) {
          name_extra.push(`<${launch.rocket.configuration.wiki_url}|rocket>`);
        }

        if (launch.infoURLs.length > 0 ) {
            for (const u of launch.infoURLs) {
                name_extra.push(`<${u.url}|more>`);
            }
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
        if (launch.pad && launch.pad.name) {
          const launch_extra = [];
          if (launch.pad.wiki_url) {
            launch_extra.push(`<${launch.pad.wiki_url}|wiki>`);
          }
          if (launch.pad.map_url) {
            launch_extra.push(`<${launch.pad.map_url}|map>`);
          }
          let lauch_extra_fmt = "";
          if (launch_extra.length > 0) {
            lauch_extra_fmt = ` (${launch_extra.join(", ")})`;
          }
          message += `${launch.pad.name}${lauch_extra_fmt}\n`;
        }
        if (launch.mission.description) {
          message += `\n${launch.mission.description}\n`;
        }

        if(launch.infographic) {
            message += `\n<${launch.infographic}|:rocket:>\n`;
        } else if(launch.image) {
            message += `\n<${launch.image}|:rocket:>\n`;
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
              "fallback": `Watch it live at ${u.url}`,
              "url": u.url
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
  console.log(channel_id, bot_access_token, messages);
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

exports.poll = poll;
