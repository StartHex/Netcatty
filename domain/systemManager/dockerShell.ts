/** Sanitize Docker container/image IDs — must match electron/bridges/systemManager/dockerOps.cjs */
export function sanitizeDockerContainerId(id: string): string {
  return String(id || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 64);
}

const CLEAR_STARTUP_OUTPUT = "printf '\\033[H\\033[2J\\033[3J';";

function buildDockerCommandWithSudoFallback(containerId: string, dockerArgs: string): string {
  const plainCommand = `docker ${dockerArgs}`;
  const sudoCommand = `sudo ${plainCommand}`;
  return [
    CLEAR_STARTUP_OUTPUT,
    `_nc_docker_err=$(docker inspect ${containerId} 2>&1 >/dev/null);`,
    '_nc_docker_status=$?;',
    `if [ "$_nc_docker_status" -eq 0 ]; then exec ${plainCommand}; fi;`,
    'case "$(printf \'%s\' "$_nc_docker_err" | tr \'[:upper:]\' \'[:lower:]\')" in',
    `*permission\\ denied*docker*|*docker*permission\\ denied*|*docker.sock*) exec ${sudoCommand} ;;`,
    '*) printf \'%s\\n\' "$_nc_docker_err" >&2; exit "$_nc_docker_status" ;;',
    'esac',
  ].join(' ');
}

/** Interactive shell into a container — prefer bash, fall back to sh. */
export function buildDockerExecShellCommand(containerId: string): string {
  const safeId = sanitizeDockerContainerId(containerId);
  if (!safeId) return 'echo "Invalid container id"';
  return buildDockerCommandWithSudoFallback(
    safeId,
    `exec -it ${safeId} sh -c 'command -v bash >/dev/null 2>&1 && exec bash || exec sh'`,
  );
}

export function buildDockerLogsCommand(containerId: string): string {
  const safeId = sanitizeDockerContainerId(containerId);
  if (!safeId) return 'echo "Invalid container id"';
  return buildDockerCommandWithSudoFallback(safeId, `logs -f --tail 200 ${safeId}`);
}
