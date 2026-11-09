# pdfeditor-pad

pdfeditor の「iPad 直接接続テスト」のページです。パソコンと iPad が、外のサーバーを通さずに同じ Wi-Fi の中だけで直接つながるかを確かめます。

- 接続には WebRTC を使います。STUN・TURN などの外のサーバーは使いません（`iceServers: []`）。
- 接続の情報（住所・合言葉・暗号の鍵の指紋）は、QR コードをカメラで読み合って交換します。
- つながった後のデータは DTLS で暗号化され、2 台の間を直接流れます。
- 一度開けば、ホーム画面に追加してネットなしでも開けます（Service Worker）。

使っている部品: [jsQR](https://github.com/cozmo/jsQR)（Apache-2.0、`vendor/jsQR.LICENSE`）、[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)（MIT、ファイル冒頭に記載）
