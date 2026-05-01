import 'dart:async';
import 'package:flutter/material.dart';
import '../../../core/network/websocket_client.dart';
import '../../../shared/services/stt_service.dart';
import '../../../shared/services/tts_service.dart';

enum InterviewPhase { ready, speaking, listening, processing }

class TranscriptEntry {
  final String role;
  final String text;
  final DateTime timestamp;

  TranscriptEntry({required this.role, required this.text, required this.timestamp});
}

class InterviewProvider extends ChangeNotifier {
  InterviewPhase _currentPhase = InterviewPhase.ready;
  InterviewPhase get currentPhase => _currentPhase;

  String? sessionId;
  String? moduleType;
  String? currentQuestion;
  String? audioUrl;
  List<String> transcript = [];
  String? errorMessage;

  // Additional properties for screen compatibility
  String questionText = "...";
  String finalQuestionText = "";
  String subtitleText = "";
  bool isStreamingText = false;
  String partialTranscript = "";
  String finalTranscript = "";
  bool isConnecting = false;
  bool isListening = false;
  bool isSessionEnded = false;
  int _silenceStrikes = 0;
  int get silenceStrikes => _silenceStrikes;

  final WebSocketClient _wsClient = WebSocketClient(
    url: 'wss://your-websocket-endpoint',
    userId: 'user123',
    sessionId: 'session123',
  );
  final SttService _sttService = SttService();
  final TtsService _ttsService = TtsService();

  StreamSubscription? _wsSubscription;

  InterviewProvider() {
    _initWebSocket();
  }

  void _initWebSocket() {
    _wsSubscription = _wsClient.messages.listen(_handleWebSocketMessage);
    _wsClient.errors.listen((error) {
      errorMessage = error;
      notifyListeners();
    });
    _wsClient.disconnects.listen((_) {
      isSessionEnded = true;
      _currentPhase = InterviewPhase.ready;
      notifyListeners();
    });
  }

  void _handleWebSocketMessage(Map<String, dynamic> message) {
    switch (message['type']) {
      case 'turn_complete':
        _handleTurnComplete(message['payload']);
        break;
      case 'termination':
        _handleTermination();
        break;
      case 'error':
        errorMessage = message['payload']['message'];
        notifyListeners();
        break;
    }
  }

  void _handleTurnComplete(Map<String, dynamic> payload) {
    currentQuestion = payload['questionText'];
    questionText = currentQuestion ?? "...";
    finalQuestionText = questionText;
    subtitleText = questionText;
    audioUrl = payload['audioUrl'];
    _currentPhase = InterviewPhase.speaking;
    notifyListeners();

    if (audioUrl != null) {
      _ttsService.playUrl(audioUrl!).then((_) {
        _currentPhase = InterviewPhase.listening;
        notifyListeners();
        _startListening();
      });
    }
  }

  void _handleTermination() {
    isSessionEnded = true;
    _currentPhase = InterviewPhase.ready;
    _cleanup();
    notifyListeners();
  }

  void _startListening() {
    isListening = true;
    _sttService.startListening(
      onPartial: (text) {
        partialTranscript = text;
        notifyListeners();
      },
      onFinal: (text) {
        finalTranscript = text;
        transcript.add(text);
        isListening = false;
        _submitResponse(text);
        notifyListeners();
      },
    );
  }

  void _submitResponse(String text) {
    _currentPhase = InterviewPhase.processing;
    notifyListeners();

    _wsClient.sendMessage({
      'type': 'turn_submit',
      'payload': {
        'sessionId': sessionId,
        'text': text,
      },
    });
  }

  void terminateSession() {
    _wsClient.sendMessage({
      'type': 'terminate_session',
      'payload': {
        'sessionId': sessionId,
      },
    });
  }

  // Additional methods for screen compatibility
  void resetForNewSession() {
    isSessionEnded = false;
    isConnecting = true;
    sessionId = null;
    subtitleText = "";
    isStreamingText = false;
    finalTranscript = "";
    partialTranscript = "";
    questionText = "";
    finalQuestionText = "";
    transcript.clear();
    _currentPhase = InterviewPhase.ready;
    _silenceStrikes = 0;
    errorMessage = null;
    notifyListeners();
  }

  Future<void> initSession(String type, {String? resumeId, String? websiteUrl}) async {
    moduleType = type;
    isConnecting = true;
    notifyListeners();

    // Connect to WebSocket
    try {
      await _wsClient.connect();
      await _wsClient.waitForConnection();
    } catch (e) {
      errorMessage = 'Failed to connect: $e';
      isConnecting = false;
      notifyListeners();
      return;
    }

    // Simulate session initialization
    await Future.delayed(const Duration(seconds: 1));
    sessionId = 'session_${DateTime.now().millisecondsSinceEpoch}';
    isConnecting = false;
    notifyListeners();
  }

  Future<void> endSession() async {
    if (isSessionEnded) return;

    terminateSession();

    isSessionEnded = true;
    _cleanup();

    notifyListeners();
  }

  void _cleanup() {
    _wsSubscription?.cancel();
    _sttService.stop();
    _ttsService.stop();
    _wsClient.disconnect();
  }

  @override
  void dispose() {
    _cleanup();
    super.dispose();
  }
}
