// gnome-forge@cwittenberg/llm_provider.js
import Gio from 'gi://Gio';

export class OllamaProvider {
    constructor(config) {
        this.url = config.url ? config.url.replace(/\/$/, '') : 'http://localhost:11434';
        this.model = config.model || 'llama3';
    }

    async call(systemPrompt, userPrompt) {
        const response = await this.chat(systemPrompt, [{ role: 'user', content: userPrompt }]);
        return response.content || "No text returned.";
    }

    async chat(systemPrompt, messages, tools = null) {
        const endpoint = `${this.url}/api/chat`;
        const payload = {
            model: this.model,
            messages: [
                { role: 'system', content: systemPrompt },
                ...messages
            ],
            stream: false
        };
        
        if (tools && tools.length > 0) {
            payload.tools = tools;
        }

        return this._executeCurl(endpoint, ['Content-Type: application/json'], JSON.stringify(payload), 'ollama');
    }

    async _executeCurl(url, headers, data, type) {
        const cmd = ['curl', '-s', '-X', 'POST', url];
        for (const h of headers) {
            cmd.push('-H', h);
        }
        cmd.push('-d', data);

        const proc = Gio.Subprocess.new(cmd, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        return new Promise((resolve, reject) => {
            proc.communicate_utf8_async(null, null, (obj, res) => {
                const [ok, stdout, stderr] = obj.communicate_utf8_finish(res);
                if (!ok || proc.get_successful() === false) {
                    reject(new Error(stderr || 'Execution failure inside transport layer'));
                    return;
                }
                try {
                    const parsed = JSON.parse(stdout);
                    
                    if (type === 'ollama') {
                        resolve({
                            content: parsed.message?.content || "",
                            toolCalls: parsed.message?.tool_calls ? parsed.message.tool_calls.map(tc => ({
                                name: tc.function.name,
                                args: tc.function.arguments
                            })) : null
                        });
                    } 
                    else if (type === 'openai') {
                        const msg = parsed.choices[0].message;
                        resolve({
                            content: msg.content || "",
                            toolCalls: msg.tool_calls ? msg.tool_calls.map(tc => ({
                                name: tc.function.name,
                                args: JSON.parse(tc.function.arguments)
                            })) : null
                        });
                    } 
                    else if (type === 'gemini') {
                        const parts = parsed.candidates[0].content.parts;
                        let content = parts.filter(p => p.text).map(p => p.text).join('\n');
                        let toolCalls = parts.filter(p => p.functionCall).map(p => ({
                            name: p.functionCall.name,
                            args: p.functionCall.args
                        }));
                        resolve({
                            content: content || "",
                            toolCalls: toolCalls.length > 0 ? toolCalls : null
                        });
                    }
                } catch (e) {
                    reject(new Error(`Transport layer parsing fault: ${stdout}`));
                }
            });
        });
    }
}

export class OpenAIProvider {
    constructor(config) {
        this.apiKey = config.apiKey || '';
        this.model = config.model || 'gpt-4o';
    }

    async call(systemPrompt, userPrompt) {
        const response = await this.chat(systemPrompt, [{ role: 'user', content: userPrompt }]);
        return response.content || "No text returned.";
    }

    async chat(systemPrompt, messages, tools = null) {
        const endpoint = 'https://api.openai.com/v1/chat/completions';
        const headers = [
            'Content-Type: application/json',
            `Authorization: Bearer ${this.apiKey}`
        ];
        const payload = {
            model: this.model,
            messages: [
                { role: 'system', content: systemPrompt },
                ...messages
            ]
        };

        if (tools && tools.length > 0) {
            payload.tools = tools;
        }

        const ollamaInstance = new OllamaProvider({});
        return ollamaInstance._executeCurl(endpoint, headers, JSON.stringify(payload), 'openai');
    }
}

export class GeminiProvider {
    constructor(config) {
        this.apiKey = config.apiKey || '';
        this.model = config.model || 'gemini-1.5-pro';
    }

    async call(systemPrompt, userPrompt) {
        const response = await this.chat(systemPrompt, [{ role: 'user', content: userPrompt }]);
        return response.content || "No text returned.";
    }

    async chat(systemPrompt, messages, tools = null) {
        const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;
        const contents = messages.map(m => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: m.content }]
        }));
        const payload = {
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: contents
        };

        if (tools && tools.length > 0) {
            // Gemini expects a specific tools array format
            payload.tools = [{
                function_declarations: tools.map(t => ({
                    name: t.function.name,
                    description: t.function.description,
                    parameters: t.function.parameters
                }))
            }];
        }

        const ollamaInstance = new OllamaProvider({});
        return ollamaInstance._executeCurl(endpoint, ['Content-Type: application/json'], JSON.stringify(payload), 'gemini');
    }
}

export function getProviderInstance(profile) {
    if (!profile) throw new Error('Missing target LLM profile setup configuration');
    switch (profile.provider) {
        case 'ollama': return new OllamaProvider(profile);
        case 'openai': return new OpenAIProvider(profile);
        case 'gemini': return new GeminiProvider(profile);
        default: throw new Error(`Unsupported engine identifier: ${profile.provider}`);
    }
}