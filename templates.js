exports.oauth_failure = function(error_message) {
  return `
  <html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Launch Library Bot - Authorization Failure</title>
    <link href="https://fonts.googleapis.com/css?family=Sunflower:300" rel="stylesheet">
  </head>
  <body style="font-family: 'Sunflower', sans-serif;">
    <h1>Error</h1>
    Unable to grant access: ${error_message}
  </body>
  </html>`;
};

exports.bot_install_success = function() {
  return `
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
    </html>`;
};

exports.reminder_access_success = function() {
  return `
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
    </html>`;
};
