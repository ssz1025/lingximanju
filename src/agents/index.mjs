// 智能体注册入口：导入即注册全部 Agent
import './narrative.mjs';
import './visual.mjs';
import './voice-agent.mjs';
import './character-agent.mjs';
import './character-portrait-agent.mjs';
import './director-agent.mjs';
import './storyboard-agent.mjs';
export { listAgents, getAgent, defineAgent } from '../core/agent.mjs';
// 非画布节点型智能体（对话式业务 Agent）也从这里统一导出，方便路由层一站式接入
export { coverChat, buildCoverPrompt, buildCoverVars, resolveChatRefs, MAX_COVER_REFS } from './cover-agent.mjs';
// 分镜板业务 Agent：分镜画面设置 + 按版式重排每段分镜板（不产出画布节点）
export { planStoryboardSheets, composeStoryboardSheets } from './storyboard-agent.mjs';
