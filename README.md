# Launch Library Slack Bot
Daily rocket launch notifications and reminders from [launchlibrary.net](https://launchlibrary.net)

Launch Library Slack Bot is a 3rd party integration into [launchlibrary.net](https://launchlibrary.net) and is not directly affiliated with the Launch Library project.  Please direct all support requests and questions to the author of this bot.

Launch Library Slack Bot is implemented as an AWS Lambda function and is deployed onto AWS.

## Installation

Make sure you're logged into Slack and then ...

<a href="https://slack.com/oauth/authorize?client_id=509826935345.509693543072&scope=bot,chat:write:bot,reminders:write,commands"><img alt="Add to Slack" height="40" width="139" src="https://platform.slack-edge.com/img/add_to_slack.png" srcset="https://platform.slack-edge.com/img/add_to_slack.png 1x, https://platform.slack-edge.com/img/add_to_slack@2x.png 2x" /></a>

## Usage

Once the Slack app is installed to your workspace use the Slack command `/launch_library_subscribe <UTC hour of day 0-23>` to enroll the current channel in daily rocket launch notifications at a specific time of day.

Example:
`/launch_library_subscribe 13`

This will enroll the current channel on daily launch notifications at 13:00 UTC
