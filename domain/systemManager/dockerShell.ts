/** Interactive shell into a container — prefer bash, fall back to sh. */
export function buildDockerExecShellCommand(containerId: string): string {
  return `docker exec -it ${containerId} sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`;
}

export function buildDockerLogsCommand(containerId: string): string {
  return `docker logs -f --tail 200 ${containerId}`;
}
