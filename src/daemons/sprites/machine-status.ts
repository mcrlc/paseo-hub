export function machineTone(
  status: "spawning" | "alive" | "terminated",
): "success" | "warning" | "neutral" {
  if (status === "alive") return "success";
  return status === "spawning" ? "warning" : "neutral";
}
