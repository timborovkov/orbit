export const EMAIL_SEND_ACTION = 'email.send';
export const EMAIL_INTRODUCTION_ACTION = 'email.introduction';
export const EMAIL_SEND_JOB = 'email.send';
export const CHANNEL_OUTBOUND_JOB = 'channel.outbound';

export type OutboundActionStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'blocked';
