import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';
import 'package:audioplayers/audioplayers.dart';
import 'package:flutter/foundation.dart';

class TtsService {
  static final TtsService _instance = TtsService._internal();
  factory TtsService() => _instance;
  TtsService._internal();

  final AudioPlayer _player = AudioPlayer();
  final List<Uint8List> _queue = [];
  bool _isPlaying = false;
  
  Function? onPlaybackComplete;

  Future<void> playBase64Chunk(String base64Data, bool isLast) async {
    if (base64Data.isNotEmpty) {
      final bytes = base64Decode(base64Data);
      _queue.add(bytes);
    }

    if (!_isPlaying && _queue.isNotEmpty) {
      _startPlayback();
    }

    if (isLast && _queue.isEmpty && !_isPlaying) {
      onPlaybackComplete?.call();
    }
  }

  Future<void> _startPlayback() async {
    if (_queue.isEmpty || _isPlaying) return;
    
    _isPlaying = true;
    
    try {
      while (_queue.isNotEmpty) {
        final chunk = _queue.removeAt(0);
        try {
          // Use setSourceBytes + resume as a more stable alternative for some versions
          await _player.setSource(BytesSource(chunk));
          await _player.resume();
          
          // Wait for completion
          await _player.onPlayerComplete.first;
          // Small gap to prevent overlapping or driver crashes
          await Future.delayed(const Duration(milliseconds: 50));
        } catch (e) {
          debugPrint('TTS Chunk Playback Error: $e');
          // Skip corrupt chunk and continue
        }
      }
    } finally {
      _isPlaying = false;
      onPlaybackComplete?.call();
    }
  }

  Future<void> stop() async {
    await _player.stop();
    _queue.clear();
    _isPlaying = false;
  }

  void dispose() {
    _player.dispose();
  }
}
