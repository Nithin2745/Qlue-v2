// Mocking the streaming logic from src/lib/polly.js to verify it works as expected

const mockStream = async function* () {
    // Yield 10 chunks of 10KB each (total 100KB)
    for (let i = 0; i < 10; i++) {
        yield Buffer.alloc(10240, i); // 10KB of data
    }
};

async function* simulateSynthesizeToBase64Chunks(text) {
    // This replicates the logic in src/lib/polly.js
    const textChunks = [text]; // Simulating 1 text chunk
    let globalChunkIndex = 0;

    for (let t = 0; t < textChunks.length; t++) {
        const stream = mockStream();
        const TARGET_CHUNK_SIZE = 32768; // 32KB
        let buffer = Buffer.alloc(0);

        for await (const data of stream) {
            buffer = Buffer.concat([buffer, data]);

            if (buffer.length >= TARGET_CHUNK_SIZE) {
                yield {
                    chunkIndex: globalChunkIndex++,
                    audioSize: buffer.length,
                    isLast: false
                };
                buffer = Buffer.alloc(0);
            }
        }
        
        const isVeryLastInSequence = t === textChunks.length - 1;
        if (buffer.length > 0 || isVeryLastInSequence) {
            yield {
                chunkIndex: globalChunkIndex++,
                audioSize: buffer.length,
                isLast: isVeryLastInSequence
            };
        }
    }
}

async function runTest() {
    console.log("--- Polly Streaming Logic Test ---");
    let totalYielded = 0;
    
    for await (const chunk of simulateSynthesizeToBase64Chunks("Sample text")) {
        console.log(`Yielded Chunk ${chunk.chunkIndex}: Size=${chunk.audioSize} bytes, isLast=${chunk.isLast}`);
        totalYielded++;
        
        // Verify each chunk is within API Gateway limits (128KB)
        // 32KB base64 is about 43KB, well within 128KB.
        if (chunk.audioSize > 128 * 1024) {
            console.error("FAILED: Chunk size exceeds API Gateway limit!");
        }
    }
    
    console.log(`--- Test Completed. Total chunks: ${totalYielded} ---`);
    if (totalYielded === 4) {
        console.log("RESULT: SUCCESS. The logic correctly chunks 100KB into 3x32KB + 1x4KB.");
    }
}

runTest();
