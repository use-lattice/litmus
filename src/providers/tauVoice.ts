import fs from 'fs/promises';
import os from 'os';
import path from 'path';

import logger from '../logger';
import { type GenAISpanContext, type GenAISpanResult, withGenAISpan } from '../tracing/genaiTracer';
import invariant from '../util/invariant';
import { safeJsonStringify } from '../util/json';
import { getNunjucksEngine } from '../util/templates';
import { sleep } from '../util/time';
import { accumulateResponseTokenUsage, createEmptyTokenUsage } from '../util/tokenUsageUtils';
import { type AudioOutput, type AudioProviderResponse, createUnifiedAudioProvider } from './audio';
import {
  convertPcm16ToWav,
  createPcm16Silence,
  getPcm16DurationSeconds,
  parseWavToPcm16,
} from './audio/wav';
import { OpenAiSpeechProvider } from './openai/speech';
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

export interface TauVoiceTranscriptionResult {
  error?: string;
  matchesExpectedTranscript?: boolean;
  metadata?: Record<string, any>;
  providerId: string;
  tokenUsage?: TokenUsage;
  transcriptSimilarity?: number;
  transcript?: string;
  cost?: number;
}

export interface TauVoiceTurn {
  turn: number;
  user: {
    text: string;
    transcript?: string;
    providerId: string;
    ttsProviderId?: string;
    audio?: AudioOutput;
    generationCost?: number;
    ttsCost?: number;
  };
  assistant: {
    text: string;
    transcript?: string;
    providerId: string;
    audio?: AudioOutput;
    cost?: number;
    eventCounts?: Record<string, number>;
    functionCalls?: Array<Record<string, any>>;
    sessionId?: string;
    usage?: Record<string, any>;
    usageBreakdown?: Record<string, any>;
    verification?: TauVoiceTranscriptionResult;
  };
  costBreakdown?: {
    total?: number;
    userGeneration?: number;
    tts?: number;
    target?: number;
    transcription?: number;
  };
  userLatencyMs?: number;
  ttsLatencyMs?: number;
  targetLatencyMs?: number;
}

type TauVoiceConfig = {
  userProvider?: string | ProviderOptions;
  ttsProvider?: string | ProviderOptions;
  transcriptionProvider?: string | ProviderOptions;
  transcriptionScope?: 'assistant-turns' | 'conversation' | 'assistant-turns-and-conversation';
  transcriptionSilenceMs?: number;
  instructions?: string;
  maxTurns?: number;
  initialMessages?: TauMessage[] | string;
  voice?: OpenAiSpeechProvider['config']['voice'];
  ttsFormat?: 'wav' | 'pcm' | 'mp3' | 'opus' | 'aac' | 'flac';
};

type TauVoiceProviderOptions = ProviderOptions & {
  resolvedUserProvider?: ApiProvider;
  resolvedTtsProvider?: ApiProvider;
  resolvedTranscriptionProvider?: ApiProvider;
  config?: TauVoiceConfig;
};

export class TauVoiceProvider implements ApiProvider {
  private readonly identifier: string;
  private readonly maxTurns: number;
  private readonly rawInstructions: string;
  private readonly resolvedUserProvider?: ApiProvider;
  private readonly resolvedTtsProvider?: ApiProvider;
  private readonly resolvedTranscriptionProvider?: ApiProvider;
  private readonly transcriptionScope: NonNullable<TauVoiceConfig['transcriptionScope']>;
  private readonly transcriptionSilenceMs: number;
  private readonly configInitialMessages?: TauMessage[] | string;
  private readonly defaultVoice?: TauVoiceConfig['voice'];
  private readonly defaultTtsFormat?: TauVoiceConfig['ttsFormat'];

  constructor({
    id,
    label,
    config = {},
    resolvedUserProvider,
    resolvedTtsProvider,
    resolvedTranscriptionProvider,
  }: TauVoiceProviderOptions) {
    this.identifier = id ?? label ?? 'promptfoo:tau-voice';
    this.maxTurns = config.maxTurns ?? 10;
    this.rawInstructions = config.instructions || '{{instructions}}';
    this.resolvedUserProvider = resolvedUserProvider;
    this.resolvedTtsProvider = resolvedTtsProvider;
    this.resolvedTranscriptionProvider = resolvedTranscriptionProvider;
    this.transcriptionScope = config.transcriptionScope || 'assistant-turns';
    this.transcriptionSilenceMs = config.transcriptionSilenceMs ?? 250;
    this.configInitialMessages = config.initialMessages;
    this.defaultVoice = config.voice;
    this.defaultTtsFormat = config.ttsFormat;
  }

  id(): string {
    return this.identifier;
  }

  private buildDefaultTtsProvider(): ApiProvider {
    return new OpenAiSpeechProvider('gpt-4o-mini-tts', {
      config: {
        voice: this.defaultVoice || 'alloy',
        format: this.defaultTtsFormat || 'pcm',
      },
    });
  }

  private extractText(output: unknown): string {
    if (typeof output === 'string') {
      return output;
    }
    return safeJsonStringify(output) || '';
  }

  private extractAudio(
    response: AudioProviderResponse | ProviderResponse,
  ): AudioOutput | undefined {
    const audio = response.audio || response.metadata?.audio;
    if (!audio?.data) {
      return undefined;
    }

    return {
      data: audio.data,
      format: audio.format || 'wav',
      transcript: audio.transcript || (typeof response.output === 'string' ? response.output : ''),
      sampleRate: audio.sampleRate,
      channels: audio.channels,
      duration: audio.duration,
    };
  }

  private getRenderedInitialMessages(vars: Record<string, any> | undefined): TauMessage[] {
    const varsInitialMessages = vars?.initialMessages as TauMessage[] | string | undefined;
    return renderAndValidateTauMessages(
      varsInitialMessages || this.configInitialMessages,
      vars,
      'TauVoice',
    );
  }

  private buildTargetContext(
    context: CallApiContextParams,
    conversationId: string,
    instructions: string,
  ): CallApiContextParams {
    return {
      ...context,
      originalProvider: undefined,
      prompt: {
        ...context.prompt,
        config: {
          ...(context.prompt.config || {}),
          instructions,
        },
      },
      vars: {
        ...context.vars,
        conversationId,
      },
      test: context.test
        ? {
            ...context.test,
            metadata: {
              ...(context.test.metadata || {}),
              conversationId,
            },
          }
        : undefined,
    };
  }

  private buildTtsContext(context?: CallApiContextParams): CallApiContextParams | undefined {
    if (!context) {
      return undefined;
    }

    return {
      ...context,
      originalProvider: undefined,
    };
  }

  private buildTranscriptionContext(
    context?: CallApiContextParams,
    config?: Record<string, any>,
  ): CallApiContextParams | undefined {
    if (!context) {
      return undefined;
    }

    return {
      ...context,
      originalProvider: undefined,
      prompt: {
        ...context.prompt,
        config: {
          ...(context.prompt.config || {}),
          ...(config || {}),
        },
      },
    };
  }

  private normalizeTranscriptForComparison(text: string | undefined): string {
    return (text || '')
      .replace(/\[[^\]]+\]\s*/g, ' ')
      .replace(/(^|\n)\s*(speaker\s+\d+|user|assistant)\s*:\s*/gi, '$1')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private calculateTranscriptSimilarity(
    actualTranscript: string | undefined,
    expectedTranscript: string | undefined,
  ): number {
    const actualTokens = this.normalizeTranscriptForComparison(actualTranscript)
      .split(' ')
      .filter(Boolean);
    const expectedTokens = this.normalizeTranscriptForComparison(expectedTranscript)
      .split(' ')
      .filter(Boolean);

    if (actualTokens.length === 0 || expectedTokens.length === 0) {
      return 0;
    }

    const expectedCounts = new Map<string, number>();
    for (const token of expectedTokens) {
      expectedCounts.set(token, (expectedCounts.get(token) || 0) + 1);
    }

    let overlap = 0;
    for (const token of actualTokens) {
      const remaining = expectedCounts.get(token) || 0;
      if (remaining > 0) {
        overlap += 1;
        expectedCounts.set(token, remaining - 1);
      }
    }

    return (2 * overlap) / (actualTokens.length + expectedTokens.length);
  }

  private addCost(totalCost: number, cost?: number): number {
    return typeof cost === 'number' && Number.isFinite(cost) ? totalCost + cost : totalCost;
  }

  private buildCostBreakdown(
    voiceTurns: TauVoiceTurn[],
    conversationTranscription?: TauVoiceTranscriptionResult,
  ): Record<string, number> | undefined {
    const breakdown = {
      userSimulation: voiceTurns.reduce((sum, turn) => sum + (turn.user.generationCost || 0), 0),
      tts: voiceTurns.reduce((sum, turn) => sum + (turn.user.ttsCost || 0), 0),
      target: voiceTurns.reduce((sum, turn) => sum + (turn.assistant.cost || 0), 0),
      transcription:
        voiceTurns.reduce((sum, turn) => sum + (turn.assistant.verification?.cost || 0), 0) +
        (conversationTranscription?.cost || 0),
    };
    const total =
      breakdown.userSimulation + breakdown.tts + breakdown.target + breakdown.transcription;

    if (total <= 0) {
      return undefined;
    }

    return {
      ...breakdown,
      total,
    };
  }

  private async writeTempAudioFile(prefix: string, wavData: Buffer): Promise<string> {
    const filePath = path.join(os.tmpdir(), `${prefix}-${crypto.randomUUID()}.wav`);
    await fs.writeFile(filePath, wavData);
    return filePath;
  }

  private getAudioAsWavBuffer(audio: AudioOutput): Buffer | undefined {
    const audioBuffer = Buffer.isBuffer(audio.data)
      ? audio.data
      : Buffer.from(audio.data, 'base64');

    if (audio.format === 'wav') {
      return audioBuffer;
    }

    if (audio.format === 'pcm16') {
      return convertPcm16ToWav(audioBuffer, audio.sampleRate || 24000);
    }

    logger.warn('[TauVoice] Unsupported audio format for transcription verification', {
      format: audio.format,
    });
    return undefined;
  }

  private getAudioAsPcmChunk(audio: AudioOutput) {
    const audioBuffer = Buffer.isBuffer(audio.data)
      ? audio.data
      : Buffer.from(audio.data, 'base64');

    if (audio.format === 'wav') {
      return parseWavToPcm16(audioBuffer);
    }

    if (audio.format === 'pcm16') {
      const sampleRate = audio.sampleRate || 24000;
      const channels = 1;
      return {
        pcmData: audioBuffer,
        sampleRate,
        channels,
        durationSeconds:
          audio.duration ?? getPcm16DurationSeconds(audioBuffer, sampleRate, channels),
      };
    }

    throw new Error(`Unsupported audio format for conversation transcription: ${audio.format}`);
  }

  private buildConversationAudio(voiceTurns: TauVoiceTurn[]): AudioOutput | undefined {
    const clips: Buffer[] = [];
    let sampleRate: number | undefined;
    let channels: number | undefined;

    for (const [turnIndex, voiceTurn] of voiceTurns.entries()) {
      for (const segment of [voiceTurn.user.audio, voiceTurn.assistant.audio]) {
        if (!segment?.data) {
          continue;
        }

        try {
          const chunk = this.getAudioAsPcmChunk(segment);
          sampleRate ??= chunk.sampleRate;
          channels ??= chunk.channels;

          if (chunk.sampleRate !== sampleRate || chunk.channels !== channels) {
            logger.warn('[TauVoice] Skipping conversation audio transcript due to audio mismatch', {
              turn: turnIndex + 1,
              expectedSampleRate: sampleRate,
              actualSampleRate: chunk.sampleRate,
              expectedChannels: channels,
              actualChannels: chunk.channels,
            });
            return undefined;
          }

          if (clips.length > 0) {
            clips.push(createPcm16Silence(this.transcriptionSilenceMs, sampleRate, channels));
          }
          clips.push(chunk.pcmData);
        } catch (error) {
          logger.warn('[TauVoice] Failed to assemble conversation audio for transcription', {
            error,
            turn: turnIndex + 1,
          });
          return undefined;
        }
      }
    }

    if (clips.length === 0 || !sampleRate || !channels) {
      return undefined;
    }

    const pcmData = Buffer.concat(clips);
    const wavData = convertPcm16ToWav(pcmData, sampleRate, channels);

    return {
      data: wavData.toString('base64'),
      format: 'wav',
      sampleRate,
      channels,
      duration: getPcm16DurationSeconds(pcmData, sampleRate, channels),
    };
  }

  private async transcribeAudioArtifact(
    transcriptionProvider: ApiProvider,
    audio: AudioOutput,
    context: CallApiContextParams | undefined,
    options?: {
      expectedTranscript?: string;
      prefix?: string;
      providerConfig?: Record<string, any>;
    },
  ): Promise<{ response?: ProviderResponse; result: TauVoiceTranscriptionResult }> {
    const wavData = this.getAudioAsWavBuffer(audio);
    if (!wavData) {
      return {
        result: {
          error: `Unsupported audio format: ${audio.format}`,
          providerId: transcriptionProvider.id(),
        },
      };
    }

    const spanContext: GenAISpanContext = {
      system: 'promptfoo',
      operationName: 'completion',
      model: 'tau-voice-audio-verification',
      providerId: transcriptionProvider.id(),
      evalId: context?.evaluationId || context?.test?.metadata?.evaluationId,
      testIndex: context?.test?.vars?.__testIdx as number | undefined,
      promptLabel: context?.prompt?.label,
      traceparent: context?.traceparent,
      requestBody: safeJsonStringify({
        expectedTranscript: options?.expectedTranscript,
        format: audio.format,
      }),
    };

    return withGenAISpan(
      spanContext,
      async () => {
        let tempFilePath: string | undefined;

        try {
          tempFilePath = await this.writeTempAudioFile(
            options?.prefix || 'tau-voice-audio',
            wavData,
          );
          const response = await transcriptionProvider.callApi(
            tempFilePath,
            this.buildTranscriptionContext(context, options?.providerConfig),
          );
          const transcript = this.extractText(response.output);
          const similarity = options?.expectedTranscript
            ? this.calculateTranscriptSimilarity(transcript, options.expectedTranscript)
            : undefined;

          return {
            response,
            result: {
              error: response.error,
              providerId: transcriptionProvider.id(),
              transcript,
              tokenUsage: response.tokenUsage,
              cost: response.cost,
              metadata: response.metadata,
              ...(options?.expectedTranscript
                ? {
                    matchesExpectedTranscript:
                      this.normalizeTranscriptForComparison(transcript) ===
                        this.normalizeTranscriptForComparison(options.expectedTranscript) ||
                      (similarity ?? 0) >= 0.6,
                    transcriptSimilarity: similarity,
                  }
                : {}),
            },
          };
        } catch (error) {
          return {
            result: {
              error: error instanceof Error ? error.message : String(error),
              providerId: transcriptionProvider.id(),
            },
          };
        } finally {
          if (tempFilePath) {
            await fs.unlink(tempFilePath).catch(() => undefined);
          }
        }
      },
      (value) => ({
        tokenUsage: value.response?.tokenUsage,
        responseBody: 'transcript' in value.result ? value.result.transcript : undefined,
      }),
    );
  }

  private async generateUserMessage(
    messages: TauMessage[],
    instructions: string,
    context?: CallApiContextParams,
  ): Promise<{ message: string; tokenUsage?: TokenUsage; cost?: number; error?: string }> {
    invariant(this.resolvedUserProvider, 'Tau Voice requires a local userProvider');

    const localContext = context
      ? {
          ...context,
          originalProvider: undefined,
        }
      : undefined;

    const response = await this.resolvedUserProvider.callApi(
      JSON.stringify(buildTauUserMessages(instructions, messages)),
      localContext,
    );

    if (response.error) {
      return { message: '', error: response.error };
    }

    return {
      message: this.extractText(response.output),
      tokenUsage: response.tokenUsage,
      cost: response.cost,
    };
  }

  private buildMetadata(
    conversationId: string,
    objective: string,
    targetPrompt: string,
    messages: TauMessage[],
    voiceTurns: TauVoiceTurn[],
    stopReason: string,
    finalAssistantTranscript?: string,
    options?: {
      conversationTranscription?: TauVoiceTranscriptionResult;
      costBreakdown?: Record<string, number>;
    },
  ): NonNullable<ProviderResponse['metadata']> {
    return {
      conversationId,
      objective,
      targetPrompt,
      transcript: formatTauConversation(messages),
      messages,
      voiceTurns,
      stopReason,
      transcriptionScope: this.transcriptionScope,
      ...(finalAssistantTranscript ? { finalAssistantTranscript } : {}),
      ...(options?.conversationTranscription
        ? { conversationTranscription: options.conversationTranscription }
        : {}),
      ...(options?.costBreakdown ? { costBreakdown: options.costBreakdown } : {}),
    };
  }

  private buildErrorResponse(
    error: string,
    totalCost: number,
    tokenUsage: TokenUsage,
    conversationId: string,
    objective: string,
    targetPrompt: string,
    messages: TauMessage[],
    voiceTurns: TauVoiceTurn[],
    stopReason: string,
    options?: {
      conversationTranscription?: TauVoiceTranscriptionResult;
      costBreakdown?: Record<string, number>;
    },
  ): ProviderResponse {
    return {
      error,
      ...(totalCost > 0 ? { cost: totalCost } : {}),
      tokenUsage,
      metadata: this.buildMetadata(
        conversationId,
        objective,
        targetPrompt,
        messages,
        voiceTurns,
        stopReason,
        undefined,
        options,
      ),
    };
  }

  private async executeVoiceTurn({
    context,
    conversationId,
    objective,
    targetPrompt,
    messages,
    voiceTurns,
    totalCost,
    tokenUsage,
    userProvider,
    userText,
    userGenerationCost,
    userLatencyMs,
    ttsProvider,
    ttsAudioProvider,
    transcriptionProvider,
    targetProvider,
    targetAudioProvider,
    targetInstructions,
    turn,
  }: {
    context: CallApiContextParams;
    conversationId: string;
    objective: string;
    targetPrompt: string;
    messages: TauMessage[];
    voiceTurns: TauVoiceTurn[];
    totalCost: number;
    tokenUsage: TokenUsage;
    userProvider: ApiProvider;
    userText: string;
    userGenerationCost?: number;
    userLatencyMs: number;
    ttsProvider: ApiProvider;
    ttsAudioProvider: ReturnType<typeof createUnifiedAudioProvider>;
    transcriptionProvider?: ApiProvider;
    targetProvider: ApiProvider;
    targetAudioProvider: ReturnType<typeof createUnifiedAudioProvider>;
    targetInstructions: string;
    turn: number;
  }): Promise<
    | {
        ttsResponse: AudioProviderResponse;
        targetResponse: AudioProviderResponse;
        transcriptionResponse?: ProviderResponse;
        assistantText: string;
        voiceTurn: TauVoiceTurn;
      }
    | { errorResponse: ProviderResponse }
  > {
    const ttsStart = Date.now();
    const ttsResponse = await ttsAudioProvider.callTextToAudioApi(
      userText,
      this.buildTtsContext(context),
    );
    const ttsLatencyMs = Date.now() - ttsStart;

    if (ttsResponse.error) {
      return {
        errorResponse: this.buildErrorResponse(
          ttsResponse.error,
          totalCost,
          tokenUsage,
          conversationId,
          objective,
          targetPrompt,
          messages,
          voiceTurns,
          'tts_error',
        ),
      };
    }

    const userAudio = this.extractAudio(ttsResponse);
    if (!userAudio?.data) {
      return {
        errorResponse: this.buildErrorResponse(
          'Tau Voice TTS provider did not return audio output',
          totalCost,
          tokenUsage,
          conversationId,
          objective,
          targetPrompt,
          messages,
          voiceTurns,
          'tts_missing_audio',
        ),
      };
    }

    const targetContext = this.buildTargetContext(context, conversationId, targetInstructions);
    const targetStart = Date.now();
    const targetResponse = await targetAudioProvider.callAudioApi(
      {
        data: userAudio.data,
        format: userAudio.format,
        transcript: userText,
      },
      targetContext,
    );
    const targetLatencyMs = Date.now() - targetStart;

    if (targetResponse.error) {
      return {
        errorResponse: this.buildErrorResponse(
          targetResponse.error,
          totalCost,
          tokenUsage,
          conversationId,
          objective,
          targetPrompt,
          messages,
          voiceTurns,
          'target_error',
        ),
      };
    }

    const assistantAudio = this.extractAudio(targetResponse);
    const assistantText =
      assistantAudio?.transcript ||
      (typeof targetResponse.output === 'string' ? targetResponse.output : '') ||
      targetResponse.metadata?.outputTranscript ||
      '';
    let transcriptionResponse: ProviderResponse | undefined;
    let verification: TauVoiceTranscriptionResult | undefined;

    if (
      transcriptionProvider &&
      assistantAudio &&
      (this.transcriptionScope === 'assistant-turns' ||
        this.transcriptionScope === 'assistant-turns-and-conversation')
    ) {
      const verificationResult = await this.transcribeAudioArtifact(
        transcriptionProvider,
        assistantAudio,
        context,
        {
          expectedTranscript: assistantText,
          prefix: `tau-voice-turn-${turn}`,
        },
      );
      transcriptionResponse = verificationResult.response;
      verification = verificationResult.result;
    }

    const turnCostBreakdown = {
      ...(userGenerationCost === undefined ? {} : { userGeneration: userGenerationCost }),
      ...(ttsResponse.cost === undefined ? {} : { tts: ttsResponse.cost }),
      ...(targetResponse.cost === undefined ? {} : { target: targetResponse.cost }),
      ...(transcriptionResponse?.cost === undefined
        ? {}
        : { transcription: transcriptionResponse.cost }),
    };
    const turnTotalCost = Object.values(turnCostBreakdown).reduce((sum, value) => sum + value, 0);

    return {
      ttsResponse,
      targetResponse,
      ...(transcriptionResponse ? { transcriptionResponse } : {}),
      assistantText,
      voiceTurn: {
        turn,
        user: {
          text: userText,
          transcript: userAudio.transcript || userText,
          providerId: userProvider.id(),
          ttsProviderId: ttsProvider.id(),
          audio: userAudio,
          ...(userGenerationCost === undefined ? {} : { generationCost: userGenerationCost }),
          ...(ttsResponse.cost === undefined ? {} : { ttsCost: ttsResponse.cost }),
        },
        assistant: {
          text: assistantText,
          transcript: assistantAudio?.transcript || assistantText,
          providerId: targetProvider.id(),
          audio: assistantAudio,
          ...(targetResponse.cost === undefined ? {} : { cost: targetResponse.cost }),
          eventCounts: targetResponse.metadata?.eventCounts,
          functionCalls: targetResponse.metadata?.functionCalls,
          sessionId: targetResponse.sessionId || targetResponse.metadata?.sessionId,
          usage: targetResponse.metadata?.usage,
          usageBreakdown: targetResponse.metadata?.usageBreakdown,
          ...(verification ? { verification } : {}),
        },
        ...(turnTotalCost > 0
          ? { costBreakdown: { ...turnCostBreakdown, total: turnTotalCost } }
          : {}),
        userLatencyMs,
        ttsLatencyMs,
        targetLatencyMs,
      },
    };
  }

  async callApi(
    _prompt: string,
    context?: CallApiContextParams,
    _callApiOptions?: CallApiOptionsParams,
  ): Promise<ProviderResponse> {
    invariant(context?.originalProvider, 'Expected originalProvider to be set');
    invariant(context?.prompt?.raw, 'Expected context.prompt.raw to be set');
    invariant(this.resolvedUserProvider, 'Tau Voice requires a local userProvider');

    const spanContext: GenAISpanContext = {
      system: 'promptfoo',
      operationName: 'chat',
      model: 'tau-voice',
      providerId: this.id(),
      evalId: context.evaluationId || context.test?.metadata?.evaluationId,
      testIndex: context.test?.vars?.__testIdx as number | undefined,
      promptLabel: context.prompt.label,
      traceparent: context.traceparent,
      requestBody:
        safeJsonStringify({
          instructions: context.vars?.instructions,
          targetPrompt: context.prompt.raw,
        }) || undefined,
    };

    const resultExtractor = (response: ProviderResponse): GenAISpanResult => ({
      tokenUsage: response.tokenUsage,
      responseBody: typeof response.output === 'string' ? response.output : undefined,
      additionalAttributes: {
        ...(response.metadata?.conversationId
          ? { 'promptfoo.tau_voice.conversation_id': response.metadata.conversationId }
          : {}),
        ...(response.metadata?.stopReason
          ? { 'promptfoo.tau_voice.stop_reason': response.metadata.stopReason }
          : {}),
        ...(Array.isArray(response.metadata?.voiceTurns)
          ? { 'promptfoo.tau_voice.turn_count': response.metadata.voiceTurns.length }
          : {}),
      },
    });

    return withGenAISpan(
      spanContext,
      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: tau voice orchestration keeps the full turn lifecycle in one place for clarity
      async () => {
        const targetProvider = context.originalProvider!;
        const userProvider = this.resolvedUserProvider!;
        const targetAudioProvider = createUnifiedAudioProvider(targetProvider);
        const ttsProvider = this.resolvedTtsProvider || this.buildDefaultTtsProvider();
        const ttsAudioProvider = createUnifiedAudioProvider(ttsProvider);
        const transcriptionProvider = this.resolvedTranscriptionProvider;
        const conversationId = `tau-voice-${crypto.randomUUID()}`;
        const instructions = getNunjucksEngine().renderString(this.rawInstructions, context.vars);
        const messages = this.getRenderedInitialMessages(context.vars);
        const voiceTurns: TauVoiceTurn[] = [];
        const tokenUsage = createEmptyTokenUsage();
        let totalCost = 0;
        const renderedTargetPrompt = getNunjucksEngine().renderString(
          context.prompt.raw,
          context.vars,
        );
        const targetInstructions = [targetProvider.config?.instructions, renderedTargetPrompt]
          .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
          .join('\n\n');

        let stopReason = 'max_turns_reached';
        let finalTargetResponse: ProviderResponse | undefined;
        let conversationTranscription: TauVoiceTranscriptionResult | undefined;

        try {
          for (let turn = 0; turn < this.maxTurns; turn++) {
            logger.debug('[TauVoice] Starting turn', {
              turn: turn + 1,
              conversationId,
            });

            const userStart = Date.now();
            const userResult = await this.generateUserMessage(messages, instructions, context);
            const userLatencyMs = Date.now() - userStart;
            if (userResult.error) {
              return this.buildErrorResponse(
                userResult.error,
                totalCost,
                tokenUsage,
                conversationId,
                instructions,
                renderedTargetPrompt,
                messages,
                voiceTurns,
                'user_provider_error',
              );
            }

            accumulateResponseTokenUsage(tokenUsage, { tokenUsage: userResult.tokenUsage });
            totalCost = this.addCost(totalCost, userResult.cost);
            const userText = userResult.message;

            if (userText.includes('###STOP###')) {
              stopReason = 'simulated_user_stop';
              break;
            }

            messages.push({ role: 'user', content: userText });
            const turnResult = await this.executeVoiceTurn({
              context,
              conversationId,
              objective: instructions,
              targetPrompt: renderedTargetPrompt,
              messages,
              voiceTurns,
              totalCost,
              tokenUsage,
              userProvider,
              userText,
              userGenerationCost: userResult.cost,
              userLatencyMs,
              ttsProvider,
              ttsAudioProvider,
              transcriptionProvider,
              targetProvider,
              targetAudioProvider,
              targetInstructions,
              turn: turn + 1,
            });
            if ('errorResponse' in turnResult) {
              return turnResult.errorResponse;
            }

            accumulateResponseTokenUsage(tokenUsage, turnResult.ttsResponse);
            accumulateResponseTokenUsage(tokenUsage, turnResult.targetResponse);
            if (turnResult.transcriptionResponse) {
              accumulateResponseTokenUsage(tokenUsage, turnResult.transcriptionResponse);
            }
            totalCost = this.addCost(totalCost, turnResult.ttsResponse.cost);
            totalCost = this.addCost(totalCost, turnResult.targetResponse.cost);
            totalCost = this.addCost(totalCost, turnResult.transcriptionResponse?.cost);
            finalTargetResponse = turnResult.targetResponse;
            messages.push({ role: 'assistant', content: turnResult.assistantText });
            voiceTurns.push(turnResult.voiceTurn);

            if (targetProvider.delay) {
              await sleep(targetProvider.delay);
            }

            if (turnResult.targetResponse.conversationEnded) {
              stopReason =
                turnResult.targetResponse.conversationEndReason || 'target_conversation_ended';
              break;
            }
          }

          if (
            transcriptionProvider &&
            (this.transcriptionScope === 'conversation' ||
              this.transcriptionScope === 'assistant-turns-and-conversation')
          ) {
            const conversationAudio = this.buildConversationAudio(voiceTurns);
            if (conversationAudio) {
              const transcriptionResult = await this.transcribeAudioArtifact(
                transcriptionProvider,
                conversationAudio,
                context,
                {
                  prefix: 'tau-voice-conversation',
                  providerConfig: {
                    speaker_labels: ['User', 'Assistant'],
                    num_speakers: 2,
                  },
                },
              );
              conversationTranscription = transcriptionResult.result;
              if (transcriptionResult.response) {
                accumulateResponseTokenUsage(tokenUsage, transcriptionResult.response);
                totalCost = this.addCost(totalCost, transcriptionResult.response.cost);
              }
            }
          }

          const transcript = formatTauConversation(messages);
          const finalAssistantMessage = [...messages]
            .reverse()
            .find((message) => message.role === 'assistant');
          return {
            output: transcript,
            ...(totalCost > 0 ? { cost: totalCost } : {}),
            tokenUsage,
            metadata: this.buildMetadata(
              conversationId,
              instructions,
              renderedTargetPrompt,
              messages,
              voiceTurns,
              stopReason,
              finalAssistantMessage?.content,
              {
                conversationTranscription,
                costBreakdown: this.buildCostBreakdown(voiceTurns, conversationTranscription),
              },
            ),
            guardrails: finalTargetResponse?.guardrails,
            audio: finalTargetResponse?.audio,
          };
        } finally {
          await transcriptionProvider?.cleanup?.();
          await ttsProvider.cleanup?.();
          await userProvider.cleanup?.();
          await targetProvider.cleanup?.();
        }
      },
      resultExtractor,
    );
  }
}
