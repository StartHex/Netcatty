import { esMonitorMessages } from './es/monitor';
import type { Messages } from './types';
import { esDatabaseMessages } from './es/database';
import { esCoreMessages } from './es/core';
import { esVaultMessages } from './es/vault';
import { esTerminalMessages } from './es/terminal';
import { esAiMessages } from './es/ai';
import { esSystemManagerMessages } from './es/systemManager';
import { esScriptsMessages } from './es/scripts';

export type { Messages } from './types';

const es: Messages = {
  ...esDatabaseMessages,
  ...esMonitorMessages,
  ...esCoreMessages,
  ...esVaultMessages,
  ...esTerminalMessages,
  ...esAiMessages,
  ...esSystemManagerMessages,
  ...esScriptsMessages,
};

export default es;