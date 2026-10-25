import { zhTWMonitorMessages } from './zh-TW/monitor';
import type { Messages } from './types';
import { zhTNDatabaseMessages } from './zh-TW/database';
import { zhTWCoreMessages } from './zh-TW/core';
import { zhTWVaultMessages } from './zh-TW/vault';
import { zhTWTerminalMessages } from './zh-TW/terminal';
import { zhTWAiMessages } from './zh-TW/ai';
import { zhTwSystemManagerMessages } from './zh-TW/systemManager';
import { zhTWScriptsMessages } from './zh-TW/scripts';

export type { Messages } from './types';

const zhTW: Messages = {
  ...zhTNDatabaseMessages,
  ...zhTWMonitorMessages,
  ...zhTWCoreMessages,
  ...zhTWVaultMessages,
  ...zhTWTerminalMessages,
  ...zhTWAiMessages,
  ...zhTwSystemManagerMessages,
  ...zhTWScriptsMessages,
};

export default zhTW;
