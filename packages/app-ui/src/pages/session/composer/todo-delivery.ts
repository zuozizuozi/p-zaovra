import type { Todo } from "@zaovra-ai/sdk/v2"

export function todoDeliveryComplete(input: {
  todos: Todo[]
  working: boolean
  userCreated?: number
  message?: { time: { created: number; completed?: number }; finish?: string; error?: unknown }
}) {
  if (input.working || !input.todos.length || input.todos.some((todo) => todo.status !== "completed")) return false
  const message = input.message
  return (
    !!message &&
    input.userCreated !== undefined &&
    message.time.created >= input.userCreated &&
    typeof message.time.completed === "number" &&
    message.finish === "stop" &&
    !message.error
  )
}
