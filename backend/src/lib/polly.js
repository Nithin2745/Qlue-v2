/**
 * Wrapper for AWS Polly streaming integration.
 */
const { PollyClient, SynthesizeSpeechCommand } = require('@aws-sdk/client-polly');
const { NodeHttpHandler } = require('@smithy/node-http-handler');

const polly = new PollyClient({ 
  region: process.env.AWS_REGION || 'us-east-1',
  requestHandler: new NodeHttpHandler({
    connectionTimeout: 5000,
    requestTimeout: 15000
  })
});

/**
 * Gets an estimated duration in ms for text
 * Based on 150 WPM (2.5 words per second)
 */
function getEstimatedDuration(text) {
  if (!text) return 0;
  const wordCount = text.split(/\s+/).length;
  // (words / 2.5 words_per_sec) * 1000 ms_per_sec
  return Math.ceil((wordCount / 2.5) * 1000);
}

/**
 * Validates and splits text at sentence boundaries if too long
 */
function splitTextAtSentences(text, maxLength = 3000) {
  if (!text) return [""];
  if (text.length <= maxLength) return [text];

  
  const chunks = [];
  const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
  
  let currentChunk = '';
  for (const sentence of sentences) {
    if ((currentChunk + sentence).length > maxLength) {
      if (currentChunk) chunks.push(currentChunk.trim());
      currentChunk = sentence;
    } else {
      currentChunk += sentence;
    }
  }
  if (currentChunk) chunks.push(currentChunk.trim());
  
  return chunks;
}

/**
 * Synthesizes text to speech and yields base64 chunks
 */
async function* synthesizeToBase64Chunks(text, options = {}) {
  const voiceId = options.VoiceId;
  if (!voiceId) {
    throw new Error('Voice ID must be provided by the user');
  }
  const engine = options.Engine || 'neural';
  
  // Polly has a 3000 character limit for regular text. 
  // We handle TextLengthExceededException proactively by chunking.
  const textChunks = splitTextAtSentences(text, 2900);
  let globalChunkIndex = 0;

  for (let t = 0; t < textChunks.length; t++) {
    const chunkText = textChunks[t];
    
    const command = new SynthesizeSpeechCommand({
      Engine: engine,
      VoiceId: voiceId,
      OutputFormat: 'mp3',
      Text: `<speak>${chunkText}</speak>`,
      TextType: 'ssml',
      SampleRate: '22050' // standard for neural mp3
    });

    try {
      console.debug(`[Polly] Sending request for chunk: "${chunkText.substring(0, 50)}..."`);
      const response = await polly.send(command);
      const stream = response.AudioStream;

      const TARGET_CHUNK_SIZE = 32768; 
      let buffer = Buffer.alloc(0);
      let isFirstInChunk = true;

      console.debug(`[Polly] Stream received, processing chunks...`);
      for await (const data of stream) {
        buffer = Buffer.concat([buffer, data]);

        // ULTRA-LOW LATENCY: Yield the very first packet immediately, regardless of size
        // Subsequent packets are grouped into 32KB to maintain efficiency.
        if (isFirstInChunk || buffer.length >= TARGET_CHUNK_SIZE) {
          console.debug(`[Polly] Yielding chunk ${globalChunkIndex} (Size: ${buffer.length}, first: ${isFirstInChunk})`);
          yield {
            chunkIndex: globalChunkIndex++,
            audioData: buffer.toString('base64')
          };
          buffer = Buffer.alloc(0);
          isFirstInChunk = false;
        }
      }
      
      const isVeryLastInSequence = t === textChunks.length - 1;
      
      if (buffer.length > 0) {
        console.debug(`[Polly] Yielding final buffer chunk ${globalChunkIndex}`);
        yield {
          chunkIndex: globalChunkIndex++,
          audioData: buffer.toString('base64')
        };
      }

    } catch (error) {
      console.error('Polly Synthesis Error:', error);
      throw error;
    }
  }
}


module.exports = {
  getEstimatedDuration,
  synthesizeToBase64Chunks
};
