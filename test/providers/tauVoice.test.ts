import { beforeEach, describe, expect, it, vi } from 'vitest';
import { convertPcm16ToWav } from '../../src/providers/audio/wav';
import { TauVoiceProvider } from '../../src/providers/tauVoice';

import type { ApiProvider, ProviderResponse } from '../../src/types/index';

vi.mock('../../src/util/time', async (importOriginal) => ({
  ...(await importOriginal()),
  sleep: vi.fn().mockResolvedValue(undefined),
}));

describe('TauVoiceProvider', () => {
  let userProvider: ApiProvider;
  let ttsProvider: ApiProvider;
  let originalProvider: ApiProvider & {
    config: Record<string, any>;
  };

  const createWavAudio = (seed: string) => {
    const pcmData = Buffer.alloc(Math.max(seed.length, 8) * 2);
    for (let index = 0; index < pcmData.length / 2; index++) {
      const charCode = seed.charCodeAt(index % seed.length) || 0;
      pcmData.writeInt16LE((charCode - 64) * 128, index * 2);
    }
    return convertPcm16ToWav(pcmData, 24000).toString('base64');
  };

  beforeEach(() => {
    userProvider = {
      id: () => 'openai:chat:gpt-4.1-mini',
      callApi: vi
        .fn()
        .mockResolvedValueOnce({
          output: 'I need a direct flight to Seattle.',
          tokenUsage: { numRequests: 1 },
        })
        .mockResolvedValueOnce({
          output: '###STOP###',
          tokenUsage: { numRequests: 1 },
        }),
    };

    ttsProvider = {
      id: () => 'openai:speech:gpt-4o-mini-tts',
      callApi: vi.fn().mockImplementation(async (prompt: string) => ({
        output: prompt,
        audio: {
          data: createWavAudio(`user:${prompt}`),
          format: 'wav',
          transcript: prompt,
          sampleRate: 24000,
          channels: 1,
        },
      })),
    };

    originalProvider = {
      id: () => 'openai:realtime:gpt-realtime',
      config: {},
      cleanup: vi.fn(async () => undefined) as ApiProvider['cleanup'],
      callApi: vi.fn().mockImplementation(
        async (_prompt: string, context?: any): Promise<ProviderResponse> => ({
          output: 'I found a direct morning option.',
          audio: {
            data: createWavAudio('assistant:direct-option'),
            format: 'wav',
            transcript: 'I found a direct morning option.',
            sampleRate: 24000,
            channels: 1,
          },
          metadata: {
            outputTranscript: 'I found a direct morning option.',
            eventCounts: {
              'response.output_audio.delta': 1,
            },
            functionCalls: [
              {
                id: 'call_1',
                name: 'search_flights',
              },
            ],
            conversationId: context?.test?.metadata?.conversationId,
          },
          tokenUsage: { numRequests: 1 },
        }),
      ),
    };
  });

  it('should run a Tau-style voice loop and collect metadata', async () => {
    const provider = new TauVoiceProvider({
      resolvedUserProvider: userProvider,
      resolvedTtsProvider: ttsProvider,
      config: {
        instructions: '{{instructions}}',
        maxTurns: 4,
      },
    });

    const result = await provider.callApi('ignored', {
      originalProvider,
      vars: {
        instructions: 'You are a traveler who wants the cheapest direct morning flight to Seattle.',
      },
      prompt: {
        raw: 'You are an airline booking agent.',
        display: 'You are an airline booking agent.',
        label: 'agent',
      },
      test: {
        metadata: {},
      },
    });

    expect(result.output).toContain('User: I need a direct flight to Seattle.');
    expect(result.output).toContain('Assistant: I found a direct morning option.');
    expect(result.metadata?.stopReason).toBe('simulated_user_stop');
    expect(result.metadata?.voiceTurns).toHaveLength(1);
    expect(result.metadata?.messages).toEqual([
      { role: 'user', content: 'I need a direct flight to Seattle.' },
      { role: 'assistant', content: 'I found a direct morning option.' },
    ]);

    expect(ttsProvider.callApi).toHaveBeenCalledWith(
      'I need a direct flight to Seattle.',
      expect.anything(),
      undefined,
    );

    const [audioPrompt, targetContext] = vi.mocked(originalProvider.callApi).mock.calls[0];
    const parsedAudioPrompt = JSON.parse(audioPrompt as string);
    expect(parsedAudioPrompt).toEqual({
      type: 'audio_input',
      audio: {
        data: createWavAudio('user:I need a direct flight to Seattle.'),
        format: 'wav',
      },
      transcript: 'I need a direct flight to Seattle.',
    });
    expect(targetContext?.prompt?.config?.instructions).toBe('You are an airline booking agent.');

    expect(result.metadata?.voiceTurns[0]).toEqual(
      expect.objectContaining({
        turn: 1,
        user: expect.objectContaining({
          text: 'I need a direct flight to Seattle.',
          providerId: 'openai:chat:gpt-4.1-mini',
          ttsProviderId: 'openai:speech:gpt-4o-mini-tts',
          audio: expect.objectContaining({
            format: 'wav',
            sampleRate: 24000,
            channels: 1,
          }),
        }),
        assistant: expect.objectContaining({
          text: 'I found a direct morning option.',
          providerId: 'openai:realtime:gpt-realtime',
          eventCounts: {
            'response.output_audio.delta': 1,
          },
          audio: expect.objectContaining({
            format: 'wav',
            sampleRate: 24000,
            channels: 1,
          }),
        }),
      }),
    );
  });

  it('should reuse one conversation id across turns and clean up the target provider', async () => {
    userProvider = {
      id: () => 'openai:chat:gpt-4.1-mini',
      callApi: vi
        .fn()
        .mockResolvedValueOnce({ output: 'First user turn' })
        .mockResolvedValueOnce({ output: 'Second user turn' })
        .mockResolvedValueOnce({ output: '###STOP###' }),
    };

    originalProvider.callApi = vi
      .fn()
      .mockResolvedValueOnce({
        output: 'First assistant turn',
        audio: {
          data: Buffer.from('assistant-audio-1').toString('base64'),
          format: 'wav',
          transcript: 'First assistant turn',
        },
      })
      .mockResolvedValueOnce({
        output: 'Second assistant turn',
        audio: {
          data: Buffer.from('assistant-audio-2').toString('base64'),
          format: 'wav',
          transcript: 'Second assistant turn',
        },
      });

    originalProvider.config.instructions = 'Follow airline policy.';

    const provider = new TauVoiceProvider({
      resolvedUserProvider: userProvider,
      resolvedTtsProvider: ttsProvider,
      config: {
        maxTurns: 5,
      },
    });

    await provider.callApi('ignored', {
      originalProvider,
      vars: { instructions: 'Handle a two-turn travel inquiry.' },
      prompt: {
        raw: 'You are a voice airline assistant.',
        display: 'You are a voice airline assistant.',
        label: 'agent',
      },
      test: {
        metadata: {},
      },
    });

    const callContexts = vi
      .mocked(originalProvider.callApi)
      .mock.calls.map(([, context]) => context?.test?.metadata?.conversationId);
    expect(callContexts[0]).toBeDefined();
    expect(callContexts[0]).toBe(callContexts[1]);
    const callInstructions = vi
      .mocked(originalProvider.callApi)
      .mock.calls.map(([, context]) => context?.prompt?.config?.instructions);
    expect(callInstructions[0]).toBe(
      'Follow airline policy.\n\nYou are a voice airline assistant.',
    );
    expect(callInstructions[1]).toBe(
      'Follow airline policy.\n\nYou are a voice airline assistant.',
    );
    expect(originalProvider.cleanup).toHaveBeenCalledTimes(1);
    expect(originalProvider.config.instructions).toBe('Follow airline policy.');
  });

  it('should seed initial messages before generating the first user turn', async () => {
    userProvider = {
      id: () => 'openai:chat:gpt-4.1-mini',
      callApi: vi
        .fn()
        .mockResolvedValueOnce({ output: 'My traveler ID is mia_li_3668.' })
        .mockResolvedValueOnce({ output: '###STOP###' }),
    };

    const provider = new TauVoiceProvider({
      resolvedUserProvider: userProvider,
      resolvedTtsProvider: ttsProvider,
      config: {
        maxTurns: 2,
        initialMessages: [
          {
            role: 'assistant',
            content: 'Welcome to Promptfoo Air. What trip can I help with today?',
          },
        ],
      },
    });

    const result = await provider.callApi('ignored', {
      originalProvider,
      vars: { instructions: 'Share your traveler ID first.' },
      prompt: {
        raw: 'You are a voice airline assistant.',
        display: 'You are a voice airline assistant.',
        label: 'agent',
      },
      test: {
        metadata: {},
      },
    });

    const seededMessages = JSON.parse(vi.mocked(userProvider.callApi).mock.calls[0][0] as string);
    expect(seededMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: 'Welcome to Promptfoo Air. What trip can I help with today?',
        }),
      ]),
    );
    expect(result.output).toContain(
      'Assistant: Welcome to Promptfoo Air. What trip can I help with today?',
    );
    expect(result.output).toContain('User: My traveler ID is mia_li_3668.');
  });

  it('should support stringified JSON initialMessages and per-test overrides', async () => {
    const provider = new TauVoiceProvider({
      resolvedUserProvider: userProvider,
      resolvedTtsProvider: ttsProvider,
      config: {
        maxTurns: 2,
        initialMessages: JSON.stringify([
          {
            role: 'assistant',
            content: 'Config greeting should be overridden.',
          },
        ]),
      },
    });

    const result = await provider.callApi('ignored', {
      originalProvider,
      vars: {
        instructions: 'Answer after the seeded greeting.',
        initialMessages: JSON.stringify([
          {
            role: 'assistant',
            content: 'Hello {{ travelerName }}.',
          },
        ]),
        travelerName: 'Mia',
      },
      prompt: {
        raw: 'You are a voice airline assistant.',
        display: 'You are a voice airline assistant.',
        label: 'agent',
      },
      test: {
        metadata: {},
      },
    });

    const seededMessages = JSON.parse(vi.mocked(userProvider.callApi).mock.calls[0][0] as string);
    expect(seededMessages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          content: 'Hello Mia.',
        }),
      ]),
    );
    expect(result.output).toContain('Assistant: Hello Mia.');
    expect(result.output).not.toContain('Config greeting should be overridden.');
  });

  it('should ignore malformed or invalid initialMessages instead of crashing', async () => {
    const provider = new TauVoiceProvider({
      resolvedUserProvider: userProvider,
      resolvedTtsProvider: ttsProvider,
      config: {
        maxTurns: 2,
        initialMessages: '[{"role":"assistant","content":"unterminated"',
      },
    });

    const result = await provider.callApi('ignored', {
      originalProvider,
      vars: {
        instructions: 'Continue normally after bad seeded history.',
        initialMessages: [
          { role: 'admin', content: 'This role is invalid and should be skipped.' },
          { role: 'assistant', content: 123 },
        ] as any,
      },
      prompt: {
        raw: 'You are a voice airline assistant.',
        display: 'You are a voice airline assistant.',
        label: 'agent',
      },
      test: {
        metadata: {},
      },
    });

    const seededMessages = JSON.parse(vi.mocked(userProvider.callApi).mock.calls[0][0] as string);
    expect(seededMessages).toEqual([
      expect.objectContaining({
        role: 'system',
      }),
    ]);
    expect(result.output).not.toContain('This role is invalid and should be skipped.');
    expect(result.output).toContain('User: I need a direct flight to Seattle.');
  });

  it('should capture transcription verification and aggregate cost breakdowns', async () => {
    const transcriptionProvider: ApiProvider = {
      id: () => 'openai:transcription:gpt-4o-transcribe-diarize',
      cleanup: vi.fn(async () => undefined) as ApiProvider['cleanup'],
      callApi: vi
        .fn()
        .mockResolvedValueOnce({
          output: '[0.00s - 0.50s] Speaker 1: I found a direct morning option.',
          cost: 0.001,
          tokenUsage: { prompt: 12, completion: 6, total: 18, numRequests: 1 },
          metadata: {
            speakers: ['Speaker 1'],
          },
        })
        .mockResolvedValueOnce({
          output:
            '[0.00s - 0.50s] User: I need a direct flight to Seattle.\n[0.50s - 1.00s] Assistant: I found a direct morning option.',
          cost: 0.002,
          tokenUsage: { prompt: 18, completion: 10, total: 28, numRequests: 1 },
          metadata: {
            speakers: ['User', 'Assistant'],
          },
        }),
    };

    userProvider = {
      id: () => 'openai:chat:gpt-4.1-mini',
      cleanup: vi.fn(async () => undefined) as ApiProvider['cleanup'],
      callApi: vi
        .fn()
        .mockResolvedValueOnce({
          output: 'I need a direct flight to Seattle.',
          cost: 0.003,
          tokenUsage: { prompt: 30, completion: 10, total: 40, numRequests: 1 },
        })
        .mockResolvedValueOnce({
          output: '###STOP###',
          tokenUsage: { prompt: 8, completion: 2, total: 10, numRequests: 1 },
        }),
    };

    ttsProvider = {
      id: () => 'openai:speech:gpt-4o-mini-tts',
      cleanup: vi.fn(async () => undefined) as ApiProvider['cleanup'],
      callApi: vi.fn().mockImplementation(async (prompt: string) => ({
        output: prompt,
        cost: 0.004,
        tokenUsage: { prompt: 6, completion: 0, total: 6, numRequests: 1 },
        audio: {
          data: createWavAudio(`tts:${prompt}`),
          format: 'wav',
          transcript: prompt,
          sampleRate: 24000,
          channels: 1,
          duration: 0.5,
        },
      })),
    };

    originalProvider = {
      id: () => 'openai:realtime:gpt-realtime',
      config: {},
      cleanup: vi.fn(async () => undefined) as ApiProvider['cleanup'],
      callApi: vi.fn().mockResolvedValue({
        output: 'I found a direct morning option.',
        cost: 0.005,
        tokenUsage: { prompt: 50, completion: 20, total: 70, numRequests: 1 },
        audio: {
          data: createWavAudio('assistant:verified'),
          format: 'wav',
          transcript: 'I found a direct morning option.',
          sampleRate: 24000,
          channels: 1,
          duration: 0.5,
        },
        metadata: {
          outputTranscript: 'I found a direct morning option.',
          functionCalls: [
            {
              id: 'call_1',
              name: 'get_user_profile',
              output: JSON.stringify({
                success: true,
                data: {
                  membership_tier: 'gold',
                  benefits: { free_checked_bags: 2 },
                },
                resolution: {
                  resolved_user_id: 'mia_li_3668',
                },
              }),
            },
          ],
          usage: {
            input_tokens: 50,
            output_tokens: 20,
            total_tokens: 70,
            input_token_details: {
              audio_tokens: 25,
              text_tokens: 25,
            },
            output_token_details: {
              audio_tokens: 10,
              text_tokens: 10,
            },
          },
          usageBreakdown: {
            audioInput: 25,
            audioOutput: 10,
            cachedInput: 0,
            imageInput: 0,
            textInput: 25,
            textOutput: 10,
            totalInput: 50,
            totalOutput: 20,
          },
        },
      }),
    };

    const provider = new TauVoiceProvider({
      resolvedUserProvider: userProvider,
      resolvedTtsProvider: ttsProvider,
      resolvedTranscriptionProvider: transcriptionProvider,
      config: {
        maxTurns: 4,
        transcriptionScope: 'assistant-turns-and-conversation',
      },
    });

    const result = await provider.callApi('ignored', {
      originalProvider,
      vars: { instructions: 'Ask for the best direct morning Seattle flight.' },
      prompt: {
        raw: 'You are a voice airline assistant.',
        display: 'You are a voice airline assistant.',
        label: 'agent',
      },
      test: {
        metadata: {},
      },
    });

    expect(result.cost).toBeCloseTo(0.015, 10);
    expect(result.metadata?.transcriptionScope).toBe('assistant-turns-and-conversation');
    expect(result.metadata?.conversationTranscription).toEqual(
      expect.objectContaining({
        providerId: 'openai:transcription:gpt-4o-transcribe-diarize',
        transcript: expect.stringContaining('User: I need a direct flight to Seattle.'),
      }),
    );
    expect(result.metadata?.costBreakdown).toEqual({
      userSimulation: 0.003,
      tts: 0.004,
      target: 0.005,
      transcription: 0.003,
      total: 0.015,
    });
    expect(result.metadata?.voiceTurns[0].assistant.verification).toEqual(
      expect.objectContaining({
        matchesExpectedTranscript: true,
        providerId: 'openai:transcription:gpt-4o-transcribe-diarize',
      }),
    );
    expect(result.metadata?.voiceTurns[0].assistant.usageBreakdown).toEqual(
      expect.objectContaining({
        audioInput: 25,
        audioOutput: 10,
      }),
    );
    expect(result.metadata?.voiceTurns[0].user.audio?.duration).toBe(0.5);
    expect(result.metadata?.voiceTurns[0].assistant.audio?.duration).toBe(0.5);
    expect(result.metadata?.voiceTurns[0].assistant.functionCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'get_user_profile',
          output: expect.stringContaining('mia_li_3668'),
        }),
      ]),
    );
    expect(transcriptionProvider.cleanup).toHaveBeenCalledTimes(1);
    expect(ttsProvider.cleanup).toHaveBeenCalledTimes(1);
    expect(userProvider.cleanup).toHaveBeenCalledTimes(1);
  });
});
