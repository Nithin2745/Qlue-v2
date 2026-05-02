import 'dart:async';
import 'package:just_audio/just_audio.dart';

class TtsService {
  final AudioPlayer _player = AudioPlayer();
  Completer<void>? _playbackCompleter;

  Future<void> playUrl(String url) async {
    await stop();
    _playbackCompleter = Completer<void>();

    try {
      await _player.setAudioSource(AudioSource.uri(Uri.parse(url)));
      await _player.play();

      // Wait for playback to complete
      await _player.processingStateStream
          .firstWhere((state) => state == ProcessingState.completed);

      _playbackCompleter!.complete();
    } catch (e) {
      _playbackCompleter!.completeError(e);
    }
  }

  Future<void> playBase64(String base64Data) async {
    // Implementation for base64 audio data
    await stop();
    _playbackCompleter = Completer<void>();
    // Add base64 decoding and playback logic here
    _playbackCompleter!.complete();
  }

  Future<void> stop() async {
    await _player.stop();
    _playbackCompleter?.complete();
  }

  Future<void> waitForCompletion() async {
    await _playbackCompleter?.future;
  }

  void dispose() {
    _player.dispose();
  }
}
