import 'dart:async';
import 'dart:convert';
import 'package:just_audio/just_audio.dart';
import 'package:flutter/foundation.dart';

class TtsService {
  static final TtsService _instance = TtsService._internal();
  factory TtsService() => _instance;
  TtsService._internal();

  final AudioPlayer _player = AudioPlayer();
  StreamController<List<int>>? _audioStreamController;
  bool _isPlaying = false;
  bool _lastChunkReceived = false;
  Function? onPlaybackComplete;

  bool get isPlaying => _isPlaying;

  Future<void> playBase64Chunk(String base64Data, bool isLast) async {
    if (isLast) {
      _lastChunkReceived = true;
      if (_audioStreamController != null && !_audioStreamController!.isClosed) {
        _audioStreamController!.close();
      }
    }

    if (base64Data.isNotEmpty) {
      try {
        final bytes = base64Decode(base64Data);
        
        if (_audioStreamController == null || _audioStreamController!.isClosed) {
          _audioStreamController = StreamController<List<int>>.broadcast();
          _startPlayback();
        }
        
        _audioStreamController!.add(bytes);
      } catch (e) {
        debugPrint('TTS Decode Error: $e');
      }
    }

    if (isLast && (_audioStreamController == null || _audioStreamController!.isClosed)) {
      _isPlaying = false;
      onPlaybackComplete?.call();
    }
  }

  Future<void> _startPlayback() async {
    if (_isPlaying || _audioStreamController == null) return;
    _isPlaying = true;

    try {
      final source = ByteStreamAudioSource(_audioStreamController!.stream);
      await _player.setAudioSource(source);
      await _player.play();
      
      // Wait for completion
      await _player.processingStateStream
          .firstWhere((state) => state == ProcessingState.completed)
          .timeout(const Duration(seconds: 60), onTimeout: () => ProcessingState.completed);
          
    } catch (e) {
      debugPrint('TTS Playback Error: $e');
    } finally {
      _isPlaying = false;
      if (_lastChunkReceived) {
        _lastChunkReceived = false;
        // Wait for speaker buffer to fully drain
        await Future.delayed(const Duration(milliseconds: 500));
        debugPrint('TTS: Buffer drained — firing onPlaybackComplete');
        onPlaybackComplete?.call();
      }
    }
  }

  Future<void> stop() async {
    await _player.stop();
    if (_audioStreamController != null && !_audioStreamController!.isClosed) {
      _audioStreamController!.close();
    }
    _audioStreamController = null;
    _isPlaying = false;
    _lastChunkReceived = false;
  }

  void dispose() {
    _player.dispose();
  }
}

class ByteStreamAudioSource extends StreamAudioSource {
  final Stream<List<int>> byteStream;
  ByteStreamAudioSource(this.byteStream);

  @override
  Future<StreamAudioResponse> request([int? start, int? end]) async {
    return StreamAudioResponse(
      sourceLength: null,
      contentLength: null,
      offset: start ?? 0,
      stream: byteStream,
      contentType: 'audio/mpeg',
    );
  }
}
