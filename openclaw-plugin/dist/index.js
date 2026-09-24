import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";
const CHANNEL = "openclaw-weixin";
const DEFAULT_BASE_URL = "http://127.0.0.1:3101";
const AGENT_LABELS = {
    main: "AI_1",
    xiaonuan: "小暖",
};
const LinkSchema = Type.Object({
    code: Type.String({
        description: "网页生成的 6 位微信绑定码。",
        pattern: "^[0-9]{6}$",
    }),
});
const ContextSchema = Type.Object({});
const ProposeSchema = Type.Object({
    action: Type.Union([
        Type.Literal("create_mission"),
        Type.Literal("create_market_item"),
        Type.Literal("create_expense"),
        Type.Literal("create_event"),
        Type.Literal("complete_mission"),
        Type.Literal("purchase_market_item"),
    ], { description: "要发起的 Rainbow-Cats 动作。" }),
    payload: Type.Record(Type.String(), Type.Unknown(), {
        description: "动作参数。业务写入不会立即执行，而是返回 6 位确认码。",
    }),
});
const ConfirmSchema = Type.Object({
    proposalId: Type.String({ description: "rainbow_propose 返回的提案 ID。" }),
    confirmationCode: Type.String({
        description: "用户明确回复的 6 位确认码。",
        pattern: "^[0-9]{6}$",
    }),
});
export function trustedIdentity(context) {
    const allowedAccounts = allowedAgentAccounts();
    const requesterSenderId = context.requesterSenderId || directSenderFromSessionKey(context);
    if (context.messageChannel !== CHANNEL ||
        !context.agentAccountId ||
        !allowedAccounts.has(context.agentAccountId) ||
        !requesterSenderId) {
        return null;
    }
    return {
        channel: context.messageChannel,
        agentAccountId: context.agentAccountId,
        requesterSenderId,
        agentLabel: AGENT_LABELS[context.agentId || ""] || "微信助手",
    };
}
export function directSenderFromSessionKey(context) {
    const parts = String(context.sessionKey || "").split(":");
    if (parts.length !== 6 ||
        parts[0] !== "agent" ||
        !parts[1] ||
        (context.agentId && parts[1] !== context.agentId) ||
        parts[2] !== context.messageChannel ||
        parts[3] !== context.agentAccountId ||
        parts[4] !== "direct" ||
        !parts[5]) {
        return "";
    }
    return parts[5];
}
function allowedAgentAccounts() {
    return new Set(String(process.env.RAINBOW_CATS_AGENT_ACCOUNT_IDS || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean));
}
async function callRainbow(path, identity, body, signal) {
    const token = String(process.env.OPENCLAW_INTERNAL_TOKEN || "").trim();
    if (!token)
        throw new Error("Rainbow-Cats 内部令牌未配置");
    const baseUrl = String(process.env.RAINBOW_CATS_INTERNAL_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
    const timeout = AbortSignal.timeout(10_000);
    const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await fetch(`${baseUrl}${path}`, {
        method: "POST",
        headers: {
            "content-type": "application/json",
            "x-openclaw-internal-token": token,
        },
        body: JSON.stringify({ ...identity, ...body }),
        signal: requestSignal,
    });
    const envelope = await response.json();
    if (!response.ok || !envelope.ok || envelope.data === null) {
        const message = envelope.error?.message || `Rainbow-Cats 请求失败 (${response.status})`;
        const error = new Error(message);
        if (envelope.error?.code)
            error.name = envelope.error.code;
        throw error;
    }
    return envelope.data;
}
function jsonContent(value) {
    return {
        content: [{ type: "text", text: JSON.stringify(value) }],
        details: value,
    };
}
export default defineToolPlugin({
    id: "rainbow-cats",
    name: "Rainbow Cats",
    description: "将可信的 AI_1 或小暖微信私聊连接到 Rainbow-Cats 双人空间。",
    tools: (tool) => [
        tool({
            name: "rainbow_link",
            label: "绑定 Rainbow-Cats",
            description: "使用用户刚从 Rainbow-Cats 网页生成的 6 位绑定码，绑定当前微信身份。",
            parameters: LinkSchema,
            factory: ({ api, toolContext }) => {
                const identity = trustedIdentity(toolContext);
                api.logger.info(`[rainbow-cats] tool-context channelMatch=${toolContext.messageChannel === CHANNEL} ` +
                    `accountAllowed=${Boolean(toolContext.agentAccountId && allowedAgentAccounts().has(toolContext.agentAccountId))} ` +
                    `senderPresent=${Boolean(toolContext.requesterSenderId)} ` +
                    `directSessionSenderPresent=${Boolean(directSenderFromSessionKey(toolContext))}`);
                if (!identity)
                    return null;
                return {
                    name: "rainbow_link",
                    label: "绑定 Rainbow-Cats",
                    description: "使用用户刚从 Rainbow-Cats 网页生成的 6 位绑定码，绑定当前微信身份。",
                    parameters: LinkSchema,
                    async execute(_id, params, signal) {
                        await callRainbow("/api/internal/openclaw/link", identity, { code: params.code }, signal);
                        return jsonContent({ bound: true });
                    },
                };
            },
        }),
        tool({
            name: "rainbow_context",
            label: "读取 Rainbow-Cats 状态",
            description: "读取当前微信发送者在双人空间中的安全快照，包括双方、任务、礼物、本人收藏、日程、支出和菜谱。",
            parameters: ContextSchema,
            factory: ({ toolContext }) => {
                const identity = trustedIdentity(toolContext);
                if (!identity)
                    return null;
                return {
                    name: "rainbow_context",
                    label: "读取 Rainbow-Cats 状态",
                    description: "读取当前微信发送者在双人空间中的安全快照，包括双方、任务、礼物、本人收藏、日程、支出和菜谱。",
                    parameters: ContextSchema,
                    async execute(_id, _params, signal) {
                        const data = await callRainbow("/api/internal/openclaw/context", identity, {}, signal);
                        return jsonContent({
                            linked: true,
                            ...data,
                            promptGuidelines: [
                                "‘我的’、‘我’永远指当前微信发送者绑定的 Rainbow-Cats 网页用户。",
                                "‘我们’指当前用户和另一位成员共同的双人空间。",
                                "AI_1 和小暖是机器人账号，不是网页用户，不能被当成任务或账目的真实操作者。",
                                "业务 ID 只用于调用工具，普通回复不向用户展示 UUID。",
                                "写入先调用 rainbow_propose；只能在同一微信私聊中收到用户明确回复的确认码后调用 rainbow_confirm。"
                            ]
                        });
                    },
                };
            },
        }),
        tool({
            name: "rainbow_propose",
            label: "创建 Rainbow-Cats 提案",
            description: "创建待确认的任务、礼物、账目或日程动作。必须把返回的 6 位确认码告诉当前用户，不能代替用户确认。",
            parameters: ProposeSchema,
            factory: ({ toolContext }) => {
                const identity = trustedIdentity(toolContext);
                if (!identity)
                    return null;
                return {
                    name: "rainbow_propose",
                    label: "创建 Rainbow-Cats 提案",
                    description: "创建待确认的任务、礼物、账目或日程动作。必须把返回的 6 位确认码告诉当前用户，不能代替用户确认。",
                    parameters: ProposeSchema,
                    async execute(_id, params, signal) {
                        const data = await callRainbow("/api/internal/openclaw/proposals", identity, { action: params.action, payload: params.payload }, signal);
                        return jsonContent(data);
                    },
                };
            },
        }),
        tool({
            name: "rainbow_confirm",
            label: "确认 Rainbow-Cats 提案",
            description: "仅在当前用户明确回复正确的 6 位确认码后执行对应提案。不要猜测或复用确认码。",
            parameters: ConfirmSchema,
            factory: ({ toolContext }) => {
                const identity = trustedIdentity(toolContext);
                if (!identity)
                    return null;
                return {
                    name: "rainbow_confirm",
                    label: "确认 Rainbow-Cats 提案",
                    description: "仅在当前用户明确回复正确的 6 位确认码后执行对应提案。不要猜测或复用确认码。",
                    parameters: ConfirmSchema,
                    async execute(_id, params, signal) {
                        const data = await callRainbow("/api/internal/openclaw/confirm", identity, {
                            proposalId: params.proposalId,
                            confirmationCode: params.confirmationCode,
                        }, signal);
                        return jsonContent(data);
                    },
                };
            },
        }),
    ],
});
