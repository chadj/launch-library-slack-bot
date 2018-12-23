const AWS = require('aws-sdk/global');
const settings = require('./settings');
const cron = require('./cron');
const apiGateway = require('./api-gateway');

AWS.config.accessKeyId = settings.AWS_ACCCESS_KEY_ID;
AWS.config.secretAccessKey = settings.AWS_SECRET_ACCESS_KEY;
AWS.config.region = settings.AWS_REGION;

//
//  Lambda function entry point
//
exports.handler = function(event, context, callback) {
  if (event.source === "aws.events") {
    // The lambda function is being called as a scheduled cron action.
    // Poll for launches to send out notifications for
    cron.poll(event, context, callback).catch(err => {
      console.error(err);
      callback(err);
    });
  } else {
    // The lambda function is being called over http via the AWS api gateway.
    console.log(event, context);
    apiGateway.endpoint(event, context, callback).catch(err => {
      console.error(err);
      callback(err);
    });
  }
};
