# Rainbow-Cats OpenClaw plugin

This plugin exposes four tools to trusted AI_1 and 小暖 direct WeChat conversations:

- `rainbow_link(code)`
- `rainbow_context()`
- `rainbow_propose(action, payload)`
- `rainbow_confirm(proposalId, confirmationCode)`

The model cannot provide or override the WeChat identity. The plugin reads
`messageChannel`, `agentAccountId`, and `requesterSenderId` from OpenClaw's
runtime-supplied tool context. The runtime `agentId` is mapped to a display
label (`main` to `AI_1`, `xiaonuan` to `小暖`). Tencent WeChat currently omits
`requesterSenderId`, so the plugin can recover it only from a strict
runtime-generated direct-chat `sessionKey` whose channel and account segments
match the other trusted context fields. Tools are unavailable unless all of
these are true:

- the channel is `openclaw-weixin`;
- `agentAccountId` is listed in `RAINBOW_CATS_AGENT_ACCOUNT_IDS`;
- `requesterSenderId` is present;
- `OPENCLAW_INTERNAL_TOKEN` is configured for the Gateway service.

Identity semantics are fixed: "I" means the web user bound to the current
WeChat sender, while "we" means that user's shared two-person space. AI_1 and
小暖 are bot accounts, not web users. A proposal can only be confirmed by the
same bound sender in the same bot conversation that created it.

Optional `RAINBOW_CATS_INTERNAL_URL` defaults to
`http://127.0.0.1:3101`. Keep all variables in a server-side environment file;
do not put their values in this repository or the OpenClaw prompt.

## Build and test

```bash
npm install
npm run plugin:build
npm run plugin:validate
npm test
```
