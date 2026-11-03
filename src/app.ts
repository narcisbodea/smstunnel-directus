/** The operation as the Flows editor shows it: "Send a text with SMSTunnel". */
import { defineOperationApp } from '@directus/extensions-sdk';
import { OPERATION_ID } from './operation';

export default defineOperationApp({
  id: OPERATION_ID,
  name: 'Send a text with SMSTunnel',
  icon: 'sms',
  description: 'Send one text from your own Android phone, from your own number.',
  overview: ({ to, kind }) => [
    { label: 'To', text: String(to ?? '') },
    { label: 'Type', text: kind === 'code' ? 'Sign-in code' : 'Text' },
  ],
  options: [
    {
      field: 'apiKey',
      name: 'API key',
      type: 'string',
      meta: {
        width: 'full',
        interface: 'input',
        required: true,
        options: { masked: true, placeholder: '{{ $env.SMSTUNNEL_API_KEY }}' },
        note:
          'Keep {{ $env.SMSTUNNEL_API_KEY }} and set SMSTUNNEL_API_KEY plus FLOWS_ENV_ALLOW_LIST=SMSTUNNEL_API_KEY in Directus\' environment: the key then stays out of the flow and its logs. Get a key at dashboard.smstunnel.io → Apps → Add an app.',
      },
      schema: { default_value: '{{ $env.SMSTUNNEL_API_KEY }}' },
    },
    {
      field: 'to',
      name: 'To',
      type: 'string',
      meta: {
        width: 'half',
        interface: 'input',
        required: true,
        options: { placeholder: '{{ $trigger.payload.phone }}' },
        note: 'One number, in international format (+14155550123).',
      },
    },
    {
      field: 'kind',
      name: 'Type',
      type: 'string',
      meta: {
        width: 'half',
        interface: 'select-dropdown',
        options: {
          choices: [
            { text: 'Text', value: 'text' },
            { text: 'Sign-in code', value: 'code' },
          ],
        },
        note: 'A sign-in code must be in the text: 4 to 10 digits on their own, 320 characters at most.',
      },
      schema: { default_value: 'text' },
    },
    {
      field: 'message',
      name: 'Message',
      type: 'text',
      meta: {
        width: 'full',
        interface: 'input-multiline',
        required: true,
        options: { placeholder: 'Hi {{ $trigger.payload.name }}, your appointment is confirmed for tomorrow at 10:00.' },
        note: 'Up to 1600 characters.',
      },
    },
    {
      field: 'deviceId',
      name: 'Phone ID',
      type: 'string',
      meta: {
        width: 'half',
        interface: 'input',
        note: 'Optional: the phone that sends, when your account has several (under Phones in your dashboard).',
      },
    },
    {
      field: 'defaultCountryCode',
      name: 'Country code',
      type: 'string',
      meta: {
        width: 'half',
        interface: 'input',
        options: { placeholder: '+40' },
        note: 'Optional: completes numbers written without + or 00.',
      },
    },
    {
      field: 'idempotencyKey',
      name: 'Idempotency key',
      type: 'string',
      meta: {
        width: 'full',
        interface: 'input',
        options: { placeholder: 'welcome-{{ $trigger.key }}' },
        note: 'Optional: one key per text. Running the flow again with the same key within 24 hours sends nothing new.',
      },
    },
  ],
});
