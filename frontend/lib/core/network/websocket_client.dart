import 'dart:async';
import 'dart:convert';
import 'package:web_socket_channel/web_socket_channel.dart';
import 'package:web_socket_channel/status.dart' as status;

class WebSocketClient {
  WebSocketChannel? _channel;
  final String url;
  final String userId;
  final String sessionId;
  final Map<String, String> headers;

  final StreamController<Map<String, dynamic>> _messageController =
      StreamController<Map<String, dynamic>>.broadcast();
  final StreamController<String> _errorController =
      StreamController<String>.broadcast();
  final StreamController<void> _disconnectController =
      StreamController<void>.broadcast();

  Timer? _reconnectTimer;
  bool _isConnecting = false;
  bool _isConnected = false;
  int _reconnectAttempts = 0;
  static const int maxReconnectAttempts = 5;
  static const Duration reconnectDelay = Duration(seconds: 2);

  Completer<void>? _connectionCompleter;

  WebSocketClient({
    required this.url,
    required this.userId,
    required this.sessionId,
    this.headers = const {},
  });

  Stream<Map<String, dynamic>> get messages => _messageController.stream;
  Stream<String> get errors => _errorController.stream;
  Stream<void> get disconnects => _disconnectController.stream;
  bool get isConnected => _isConnected;

  Future<void> connect() async {
    if (_isConnecting || _isConnected) return;

    _isConnecting = true;
    _connectionCompleter = Completer<void>();

    try {
      final uri = Uri.parse(url);
      _channel = WebSocketChannel.connect(uri);

      await _channel!.ready;
      _isConnected = true;
      _isConnecting = false;
      _reconnectAttempts = 0;

      // Send initial connection message
      _sendMessage({
        'type': 'connect',
        'userId': userId,
        'sessionId': sessionId,
      });

      // Listen to incoming messages
      _channel!.stream.listen(
        _handleMessage,
        onError: _handleError,
        onDone: _handleDisconnect,
      );

      _connectionCompleter!.complete();
    } catch (e) {
      _isConnecting = false;
      _connectionCompleter!.completeError(e);
      _scheduleReconnect();
    }
  }

  Future<void> waitForConnection() async {
    if (_connectionCompleter != null) {
      await _connectionCompleter!.future;
    }
  }

  void _handleMessage(dynamic message) {
    try {
      final data = jsonDecode(message as String) as Map<String, dynamic>;
      _messageController.add(data);
    } catch (e) {
      _errorController.add('Failed to parse message: $e');
    }
  }

  void _handleError(Object error) {
    _errorController.add('WebSocket error: $error');
    _handleDisconnect();
  }

  void _handleDisconnect() {
    _isConnected = false;
    _disconnectController.add(null);
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_reconnectAttempts >= maxReconnectAttempts) return;

    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(
      reconnectDelay * (_reconnectAttempts + 1),
      () {
        _reconnectAttempts++;
        connect();
      },
    );
  }

  void sendMessage(Map<String, dynamic> message) {
    if (_isConnected && _channel != null) {
      _sendMessage(message);
    } else {
      _errorController.add('Cannot send message: not connected');
    }
  }

  void _sendMessage(Map<String, dynamic> message) {
    try {
      final jsonMessage = jsonEncode(message);
      _channel!.sink.add(jsonMessage);
    } catch (e) {
      _errorController.add('Failed to send message: $e');
    }
  }

  void disconnect() {
    _reconnectTimer?.cancel();
    _channel?.sink.close(status.goingAway);
    _channel = null;
    _isConnected = false;
    _isConnecting = false;
    _disconnectController.add(null);
  }

  void dispose() {
    disconnect();
    _messageController.close();
    _errorController.close();
    _disconnectController.close();
  }
}
