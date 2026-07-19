// @ts-nocheck

import { Zaovra } from "@zaovra-ai/core"
import { ReadTool } from "@zaovra-ai/core/tools"

const zaovra = Zaovra.make({})

zaovra.tool.add(ReadTool)

zaovra.tool.add({
  name: "bash",
  schema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "The command to run.",
      },
    },
    required: ["command"],
  },
  execute(input, ctx) {},
})

zaovra.auth.add({
  provider: "openai",
  type: "api",
  value: process.env.OPENAI_API_KEY,
})

zaovra.agent.add({
  name: "build",
  permissions: [],
  model: {
    id: "gpt-5-5",
    provider: "openai",
    variant: "xhigh",
  },
})

const sessionID = await zaovra.session.create({
  agent: "build",
})

zaovra.subscribe((event) => {
  console.log(event)
})

await zaovra.session.prompt({
  sessionID,
  text: "hey what is up",
})

await zaovra.session.prompt({
  sessionID,
  text: "what is up with this",
  files: [
    {
      mime: "image/png",
      uri: "data:image/png;base64,xxxx",
    },
  ],
})

await zaovra.session.wait()

console.log(await zaovra.session.messages(sessionID))
