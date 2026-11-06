export function newSessionGreeting(hour: number) {
  if (hour >= 5 && hour < 11) return "session.new.greeting.morning"
  if (hour >= 11 && hour < 14) return "session.new.greeting.noon"
  if (hour >= 14 && hour < 18) return "session.new.greeting.afternoon"
  return "session.new.greeting.evening"
}
