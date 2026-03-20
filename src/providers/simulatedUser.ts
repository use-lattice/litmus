import logger from '../logger';
import { getSessionId } from '../redteam/util';
import invariant from '../util/invariant';
import { safeJsonStringify } from '../util/json';
import { getNunjucksEngine } from '../util/templates';
import { sleep } from '../util/time';
import { accumulateResponseTokenUsage, createEmptyTokenUsage } from '../util/tokenUsageUtils';
import { PromptfooSimulatedUserProvider } from './promptfoo';
import {
  buildTauUserMessages,
  formatTauConversation,
  renderAndValidateTauMessages,
  type TauMessage,
} from './tauShared';

import type {
  ApiProvider,
  CallApiContextParams,
  CallApiOptionsParams,
  ProviderOptions,
  ProviderResponse,
  TokenUsage,
} from '../types/index';

export type Message = TauMessage;

type AgentProviderOptions = ProviderOptions & {
  resolvedUserProvider?: ApiProvider;
  config?: {
    userProvider?: string | ProviderOptions;
    instructions?: string;
    maxTurns?: number;
    stateful?: boolean;
    /**
     * Pre-defined conversation history to start from.
     * Can be an array of Message objects or a file:// path to JSON/YAML.
     * Useful for testing specific conversation states or reproducing bugs.
     */
    initialMessages?: Message[] | string;
  };
};

/**
 * TODO(Will): Ideally this class is an Abstract Base Class that's implemented by the
 * Redteam and Non-Redteam SimulatedUser Providers. Address this in a follow-up PR.
 */
export class SimulatedUser implements ApiProvider {
  private readonly identifier: string;
  private readonly maxTurns: number;
  private readonly rawInstructions: string;
  private readonly stateful: boolean;
  private readonly configInitialMessages?: Message[] | string;
  private readonly resolvedUserProvider?: ApiProvider;

  /**
   * Because the SimulatedUser is inherited by the RedteamMischievousUserProvider, and different
   * Cloud tasks are used for each, the taskId needs to be explicitly defined/scoped.
   */
  readonly taskId: string = 'tau';

  constructor({ id, label, config = {}, resolvedUserProvider }: AgentProviderOptions) {
    this.identifier = id ?? label ?? 'agent-provider';
    this.maxTurns = config.maxTurns ?? 10;
    this.rawInstructions = config.instructions || '{{instructions}}';
    this.stateful = config.stateful ?? false;
    this.configInitialMessages = config.initialMessages;
    this.resolvedUserProvider = resolvedUserProvider;
  }

  id() {
    return this.identifier;
  }

  private async sendMessageToRemoteUser(
    messages: Message[],
    userProvider: PromptfooSimulatedUserProvider,
  ): Promise<{ messages: Message[]; tokenUsage?: TokenUsage; error?: string }> {
    logger.debug('[SimulatedUser] Sending message to simulated user provider');

    const flippedMessages = messages.map((message) => {
      return {
        role: message.role === 'user' ? 'assistant' : 'user',
        content: message.content,
      };
    });

    const response = await userProvider.callApi(JSON.stringify(flippedMessages));

    // Propagate error from remote generation disable check
    if (response.error) {
      return {
        messages,
        error: response.error,
      };
    }

    logger.debug(`User: ${response.output}`);
    return {
      messages: [...messages, { role: 'user', content: String(response.output || '') }],
      tokenUsage: response.tokenUsage,
    };
  }

  private async sendMessageToLocalUser(
    messages: Message[],
    userProvider: ApiProvider,
    instructions: string,
    context?: CallApiContextParams,
  ): Promise<{ messages: Message[]; tokenUsage?: TokenUsage; error?: string }> {
    logger.debug('[SimulatedUser] Sending message to local simulated user provider');

    const localContext = context
      ? {
          ...context,
          originalProvider: undefined,
        }
      : undefined;

    const response = await userProvider.callApi(
      JSON.stringify(buildTauUserMessages(instructions, messages)),
      localContext,
    );

    if (response.error) {
      return {
        messages,
        error: response.error,
      };
    }

    const output =
      typeof response.output === 'string' ? response.output : safeJsonStringify(response.output);

    logger.debug(`User: ${output}`);
    return {
      messages: [...messages, { role: 'user', content: output || '' }],
      tokenUsage: response.tokenUsage,
    };
  }

  private async sendMessageToUser(
    messages: Message[],
    instructions: string,
    context?: CallApiContextParams,
  ): Promise<{ messages: Message[]; tokenUsage?: TokenUsage; error?: string }> {
    if (this.resolvedUserProvider) {
      return this.sendMessageToLocalUser(
        messages,
        this.resolvedUserProvider,
        instructions,
        context,
      );
    }

    const remoteUserProvider = new PromptfooSimulatedUserProvider({ instructions }, this.taskId);
    return this.sendMessageToRemoteUser(messages, remoteUserProvider);
  }

  private async sendMessageToAgent(
    messages: Message[],
    targetProvider: ApiProvider,
    context: CallApiContextParams,
  ): Promise<ProviderResponse> {
    invariant(context?.prompt?.raw, 'Expected context.prompt.raw to be set');

    // Include the assistant's prompt/instructions as a system message
    const agentPrompt = context.prompt.raw;
    const agentVars = context.vars;
    const renderedPrompt = getNunjucksEngine().renderString(agentPrompt, agentVars);

    // For stateful providers:
    //   - First turn (no sessionId): send system prompt + user message to establish session
    //   - Subsequent turns (sessionId exists): send only user message (provider maintains state)
    // For non-stateful providers: always send system prompt + full conversation
    const targetPrompt = this.stateful
      ? context.vars?.sessionId
        ? JSON.stringify([{ role: 'user', content: messages[messages.length - 1].content }])
        : JSON.stringify([
            { role: 'system', content: renderedPrompt },
            { role: 'user', content: messages[messages.length - 1].content },
          ])
      : JSON.stringify([{ role: 'system', content: renderedPrompt }, ...messages]);

    logger.debug(`[SimulatedUser] Sending message to target provider: ${targetPrompt}`);

    const response = await targetProvider.callApi(targetPrompt, context);

    if (response.sessionId) {
      context = context ?? { vars: {}, prompt: { raw: '', label: 'target' } };
      context.vars.sessionId = response.sessionId;
    }

    if (targetProvider.delay) {
      logger.debug(`[SimulatedUser] Sleeping for ${targetProvider.delay}ms`);
      await sleep(targetProvider.delay);
    }

    logger.debug(`[SimulatedUser] Agent: ${response.output}`);
    return response;
  }

  async callApi(
    // NOTE: The `prompt` parameter is not used directly; `context.prompt.raw` is used instead
    // to extract the assistant's system instructions. The simulated user's instructions come from vars.
    _prompt: string,
    context?: CallApiContextParams,
    _callApiOptions?: CallApiOptionsParams,
  ): Promise<ProviderResponse> {
    invariant(context?.originalProvider, 'Expected originalProvider to be set');
    const targetProvider = context.originalProvider;

    const instructions = getNunjucksEngine().renderString(this.rawInstructions, context?.vars);

    logger.debug(`[SimulatedUser] Formatted user instructions: ${instructions}`);

    // Support initial messages from either vars.initialMessages (per-test) or config.initialMessages (provider-level)
    // vars.initialMessages takes precedence over config.initialMessages
    // Both can be arrays or file:// paths
    const varsInitialMessages = context?.vars?.initialMessages as Message[] | string | undefined;
    const messages = renderAndValidateTauMessages(
      varsInitialMessages || this.configInitialMessages,
      context?.vars,
      'SimulatedUser',
    );

    if (messages.length > 0) {
      logger.debug(`[SimulatedUser] Starting with ${messages.length} initial messages`);
    }

    const maxTurns = this.maxTurns;

    const tokenUsage = createEmptyTokenUsage();

    let agentResponse: ProviderResponse | undefined;

    // If initial messages end with user message, agent needs to respond first to avoid consecutive user messages
    const lastInitialRole = messages.length > 0 ? messages[messages.length - 1].role : null;
    if (lastInitialRole === 'user') {
      logger.debug(
        '[SimulatedUser] Initial messages end with user message, getting agent response first',
      );
      agentResponse = await this.sendMessageToAgent(messages, targetProvider, context);

      // Check for errors from agent response
      if (agentResponse.error) {
        return {
          error: agentResponse.error,
          tokenUsage,
        };
      }

      messages.push({ role: 'assistant', content: String(agentResponse.output ?? '') });
      accumulateResponseTokenUsage(tokenUsage, agentResponse);
    }

    for (let i = 0; i < maxTurns; i++) {
      logger.debug(`[SimulatedUser] Turn ${i + 1} of ${maxTurns}`);

      // NOTE: Simulated-user provider acts as a judge to determine whether the instruction goal is satisfied.
      const userResult = await this.sendMessageToUser(messages, instructions, context);

      // Check for errors from remote generation disable
      if (userResult.error) {
        return {
          error: userResult.error,
          tokenUsage,
        };
      }

      const { messages: messagesToUser, tokenUsage: userTokenUsage } = userResult;
      accumulateResponseTokenUsage(tokenUsage, { tokenUsage: userTokenUsage });
      const lastMessage = messagesToUser[messagesToUser.length - 1];

      // Check whether the judge has determined that the instruction goal is satisfied.
      if (
        lastMessage.content &&
        typeof lastMessage.content === 'string' &&
        lastMessage.content.includes('###STOP###')
      ) {
        break;
      }

      messages.push(lastMessage);

      agentResponse = await this.sendMessageToAgent(messagesToUser, targetProvider, context);

      // Check for errors from agent response
      if (agentResponse.error) {
        return {
          error: agentResponse.error,
          tokenUsage,
        };
      }

      messages.push({ role: 'assistant', content: String(agentResponse.output ?? '') });

      accumulateResponseTokenUsage(tokenUsage, agentResponse);
    }

    return this.serializeOutput(
      messages,
      tokenUsage,
      agentResponse,
      getSessionId(agentResponse, context),
    );
  }

  toString() {
    return 'AgentProvider';
  }

  serializeOutput(
    messages: Message[],
    tokenUsage: TokenUsage,
    finalTargetResponse: ProviderResponse | undefined,
    sessionId?: string,
  ) {
    return {
      output: formatTauConversation(messages),
      tokenUsage,
      metadata: {
        messages,
        sessionId,
      },
      guardrails: finalTargetResponse?.guardrails,
    };
  }
}
