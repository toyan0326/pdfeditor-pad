# pdfeditor-pad

pdfeditor の iPad 手書きページです（https://toyan0326.github.io/pdfeditor-pad/）。

- PC の pdfeditor で「iPad で書く」を押すと出る QR を読むと開き、Apple Pencil で書いた線が PC の PDF に注釈として入ります。
- PC と iPad は WebRTC で直接つながります。STUN・TURN などの外のサーバーは使いません。
  接続の情報（住所・合言葉・暗号の鍵の指紋）は QR を読み合って交換し、データは DTLS で暗号化されて 2 台の間だけを流れます。
- ホーム画面に追加すると、ネットにつながらなくても開けます（Service Worker）。
- `test/` は接続だけを確かめるテストのページです。

このリポジトリの中身は、pdfeditor（非公開）の `tools/build-pad.sh` で作った `web/pad` をそのままコピーしたものです。

使っている部品: [jsQR](https://github.com/cozmo/jsQR)（Apache-2.0、`vendor/jsQR.LICENSE`）、[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator)（MIT、ファイル冒頭に記載）
