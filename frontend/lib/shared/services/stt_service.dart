import 'package:speech_to_text/speech_to_text.dart';
import 'package:speech_to_text/speech_recognition_result.dart';

class SttService {
  final SpeechToText _speech = SpeechToText();
  bool _isInitialized = false;

  Future<bool> init() async {
    if (_isInitialized) return true;

    _isInitialized = await _speech.initialize(
      onError: (error) => print('STT Error: $error'),
      onStatus: (status) => print('STT Status: $status'),
    );

    return _isInitialized;
  }

  void startListening({
    required Function(String) onPartial,
    required Function(String) onFinal,
  }) {
    if (!_isInitialized) return;

    _speech.listen(
      onResult: (SpeechRecognitionResult result) {
        if (result.finalResult) {
          onFinal(result.recognizedWords);
        } else {
          onPartial(result.recognizedWords);
        }
      },
      listenFor: const Duration(seconds: 30),
      pauseFor: const Duration(seconds: 5),
      partialResults: true,
      localeId: 'en_US',
    );
  }

  void stop() {
    _speech.stop();
  }

  bool get isListening => _speech.isListening;
}
