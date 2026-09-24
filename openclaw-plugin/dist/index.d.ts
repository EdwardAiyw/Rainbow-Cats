type ToolContext = {
    agentId?: string;
    messageChannel?: string;
    agentAccountId?: string;
    requesterSenderId?: string;
    sessionKey?: string;
};
type TrustedIdentity = {
    channel: string;
    agentAccountId: string;
    requesterSenderId: string;
    agentLabel: string;
};
export declare function trustedIdentity(context: ToolContext): TrustedIdentity | null;
export declare function directSenderFromSessionKey(context: ToolContext): string;
declare const _default: import("openclaw/plugin-sdk/tool-plugin").DefinedToolPluginEntry;
export default _default;
