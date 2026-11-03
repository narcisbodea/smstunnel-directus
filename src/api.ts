/**
 * The operation's server side, run in Directus' extension sandbox: it may only call https://smstunnel.io
 * (package.json → directus:extension.sandbox.requestedScopes) and sees nothing else of Directus.
 *
 * A plain { id, handler } object (what defineOperationApi returns): importing the SDK at run time would bundle
 * its dependencies into the sandbox for nothing.
 */
import type { OperationApiConfig } from '@directus/extensions';
import { log, request } from 'directus:api';
import { OPERATION_ID, sendText, type SendTextOptions } from './operation';
import { sandboxTransport, type SandboxRequest } from './sandbox-transport';

const operation: OperationApiConfig<SendTextOptions> = {
  id: OPERATION_ID,
  handler: async (options) => {
    const result = await sendText(options, sandboxTransport(request as unknown as SandboxRequest));
    if (result.queued) log(`SMSTunnel: text ${result.messageId} is queued: your phone is offline, it goes out when the phone is back online.`);
    return result;
  },
};

export default operation;
