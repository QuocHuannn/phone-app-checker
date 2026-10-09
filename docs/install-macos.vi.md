# phone-app-checker – Hướng dẫn cài đặt và dùng thử trên macOS

> English version: [install-macos.md](install-macos.md). Phần mềm theo giấy phép GPL-3.0-or-later; xem thêm [responsible-use.md](responsible-use.md) (tiếng Anh) về việc dùng có trách nhiệm.

Tài liệu này dành cho người **không cần biết lập trình**. Làm lần lượt từng mục, copy–paste từng lệnh vào ứng dụng **Terminal** (Spotlight: bấm `Cmd + Space`, gõ `Terminal`, Enter). Không cần cài Node.js, npm, Homebrew hay Xcode: mọi thứ đã nằm sẵn trong file tải về.

> **Đọc trước khi dùng.** phone-app-checker kiểm tra một danh sách số điện thoại xem có tài khoản Telegram, WhatsApp, Zalo, Viber, LINE hay không, bằng các phần mềm *không chính thức* – cách dùng này **vi phạm điều khoản sử dụng** của các ứng dụng đó. Tài khoản dùng để kiểm tra có thể bị giới hạn hoặc bị khóa. Chỉ dùng **SIM/tài khoản riêng, chấp nhận mất**; tuyệt đối không dùng số cá nhân hay số đang phục vụ kinh doanh. Chỉ kiểm tra số của người đã đồng ý được liên hệ – công cụ **không** tự kiểm tra sự đồng ý đó. Xem thêm mục 11.
>
> Bản này được kiểm thử tự động trên máy phát triển (macOS 27, Apple Silicon). Với tài khoản thật, mới chỉ **WhatsApp** được chạy thử một lần (đăng nhập bằng mã ghép đôi và vài lượt tra cứu); **Telegram, Zalo, Viber, LINE chưa được kiểm chứng trên nền tảng thật**, chưa chạy thử trên Mac của bạn và chưa chạy thử trên macOS 13.5. Một kết quả `yes` / `not_found` chỉ là **quan sát tại một thời điểm** – không xác nhận người đó là ai, tài khoản còn hoạt động hay không, hay hiện giờ vẫn như vậy – nên phải đối chiếu thủ công như mục 12 trước khi tin dùng.

## Cách dùng nhanh: cài đặt, rồi chỉ cần gõ `phone-app-checker`

1. Cài đặt (mục 4): `bash ~/Downloads/phone-app-checker-0.1.0-macos-arm64/install.sh`.
2. Mở cửa sổ Terminal **mới** và gõ đúng một lệnh, không thêm gì khác, rồi nhấn Enter:

   ```sh
   phone-app-checker
   ```

3. Một **menu** hiện ra (khung tên + phiên bản, dòng `Accounts ready:` cho biết app nào đã có tài khoản, rồi danh sách có màu). Mặc định menu bằng **tiếng Anh**; muốn tiếng Việt, bấm `L`, chọn `2` (Tiếng Việt), lựa chọn được nhớ cho lần sau (xem "Ngôn ngữ của menu" ngay dưới). **Dùng phím mũi tên ↑ ↓ rồi Enter**, hoặc bấm thẳng số của dòng (`1`–`6`, `L`, `0`) không cần Enter; `q` hoặc `Esc` để thoát (hoặc quay lại ở danh sách con); làm xong mỗi việc menu tự quay lại (Ctrl-C hoặc Ctrl-D cũng thoát gọn). Nếu Terminal không hỗ trợ (ví dụ đặt `NO_COLOR` hoặc `TERM=dumb`) menu tự chuyển về kiểu cũ: gõ số rồi Enter:

   | Số | Việc (tên trên menu tiếng Anh → tiếng Việt) |
   | --- | --- |
   | 1 | `Check a CSV file` = Kiểm tra file CSV: **kéo file CSV từ Finder thả vào cửa sổ Terminal** rồi Enter, chọn ứng dụng, chọn nơi lưu báo cáo (mặc định `report.csv` cạnh file CSV; nếu đã có file cùng tên, menu hỏi trước khi ghi đè). Chưa đăng nhập tài khoản nào thì menu báo và đề nghị đăng nhập luôn. |
   | 2 | `Log in an app account` = Đăng nhập tài khoản app: chọn ứng dụng và đặt tên tài khoản (Enter = `default`). WhatsApp và Telegram hỏi thêm cách đăng nhập (quét QR, hoặc mã ghép đôi / số điện thoại + mã); Telegram hỏi `api_id`/`api_hash` một lần và tự lưu vào file cấu hình (mục 6.1). Mã QR hiện ngay trong cửa sổ (mục 6.0). |
   | 3 | `View logged-in accounts` = Xem tài khoản đã đăng nhập (lệnh `accounts`). |
   | 4 | `Rebuild the latest report` = Dựng lại báo cáo từ kết quả đã lưu (lệnh `report`), không kiểm tra thêm. |
   | 5 | `Check this Mac is ready (doctor)` = Kiểm tra máy sẵn sàng (lệnh `doctor`, mục 5). Vẫn chỉ là kiểm tra offline, không chứng minh tài khoản còn dùng được. |
   | 6 | `Guide / warnings` = Hướng dẫn và cảnh báo ngắn (cần sự đồng ý của người có số; `not_found` có thể do họ ẩn số; LINE chỉ có nghĩa với HK/JP/KR/TW/TH; Zalo chỉ số Việt Nam; nguy cơ tài khoản bị khóa). |
   | L | `Language / Ngôn ngữ / …` = đổi ngôn ngữ của menu (xem ngay dưới). |
   | 0 | `Quit` = Thoát. |

   Mỗi mục của menu chạy đúng lệnh thường tương ứng; lệnh lỗi thì menu in thông báo và ở lại menu. Menu **chỉ mở khi bạn gõ `phone-app-checker` không kèm gì** trong Terminal; trong script hoặc khi đã gõ lệnh con (`check`, `login`, `doctor`, …) mọi thứ chạy y như cũ (mục 8 liệt kê các lệnh đó).

   **Ngôn ngữ của menu.** Menu **mặc định bằng tiếng Anh** (kể cả trên máy dùng tiếng Việt). Gõ `L` rồi Enter để chọn: `1` English, `2` Tiếng Việt, `3` Bahasa Indonesia, `4` Bahasa Melayu, `5` 한국어, `6` 简体中文. Menu đổi ngôn ngữ ngay và nhớ lựa chọn cho lần mở sau (lưu trong file `menu-language` ở thư mục dữ liệu `~/Library/Application Support/phone-app-checker`; file này bị xóa cùng thư mục khi gỡ cài đặt kèm `--purge-data`). Muốn đổi tạm mà không lưu: `phone-app-checker --lang vi`, hoặc đặt biến môi trường `PHONE_APP_CHECKER_LANG=vi` (thứ tự ưu tiên: `--lang` → biến môi trường → lựa chọn đã lưu → tiếng Anh; giá trị không hợp lệ cho ra tiếng Anh, không báo lỗi). Mã ngôn ngữ: `en`, `vi`, `id`, `ms`, `ko`, `zh`. Nếu menu đang ở ngôn ngữ bạn không đọc được, dòng `L. Language / Ngôn ngữ / Bahasa / 언어 / 语言` luôn có ở mọi màn hình menu; chỉ cần gõ `L`.

   > **Trung thực về bản dịch:** tiếng Anh và tiếng Việt là bản chính của menu. Các bản **Bahasa Indonesia, Bahasa Melayu, 한국어, 简体中文 là bản dịch nháp đầu tiên do máy dịch, chưa được người bản ngữ xem lại**; có thể có chỗ sai hoặc không tự nhiên. Chỉ dịch menu của chương trình: các thông báo của lệnh `doctor`, `check`, `login`… vẫn bằng tiếng Anh, và tài liệu này vẫn là tiếng Việt. Nếu bạn là người bản ngữ và thấy chỗ sai, hãy báo để sửa.

   **Bạn sẽ thấy gì trên từng màn hình** (đây là bản chụp chữ từ lần chạy thử tự động trong cửa sổ 80x24; chỉ là hình minh họa, **chưa** chạy với tài khoản thật; màu và biểu tượng thấy trên Terminal thật):

   - *Menu chính*: khung tên + phiên bản, trạng thái từng app (`✅` đã có tài khoản và số lượng, `⬜` chưa), danh sách dòng có biểu tượng, dòng nhắc phím ở cuối.

     ```text
     ╭─ Phone App Checker 0.1.0 ──────────────────────────────────────────
     │ Accounts ready:
     │ ⬜ telegram – · ✅ whatsapp 1 · ⬜ zalo – · ⬜ viber – · ⬜ line –
     ╰────────────────────────────────────────────────────────────────────
     ❯ 1 🔍 Check a CSV file
       2 🔑 Log in an app account
       ...
       0 🚪 Quit
     ↑↓ move · Enter select · q quit
     ```

   - *Đăng nhập Telegram* (menu `2` → Telegram): trước khi hỏi bất cứ điều gì, màn hình cho biết **3 bước** và **vì sao cần khóa**: Telegram bắt buộc mọi chương trình đăng nhập phải có `api_id` / `api_hash` (miễn phí, chỉ tạo một lần, mỗi người tự tạo; công cụ này không kèm khóa dùng chung vì vi phạm quy định của Telegram và dễ bị khóa tài khoản). **Mã QR chỉ hiện ở Bước 3, ngay sau khi lưu khóa.** Nếu khóa đã có sẵn, màn hình ghi `API keys found` và nhảy thẳng tới Bước 3.

     ```text
       Step 1/3 - Get your free Telegram API keys (one-time)
       Step 2/3 - Save the keys
       Step 3/3 - Scan the QR code (or enter phone + code)
     Why keys? Telegram requires them from every program that logs in to Telegram.
     The QR code appears in Step 3, right after the keys are saved.
     Account name (Enter = default):
     ```

     Bước 1 in địa chỉ <https://my.telegram.org/apps>, nói điền gì vào form (`App title` và `Short name` tùy ý, `Platform: Other`) và hỏi `Open https://my.telegram.org/apps in your browser now? (Y/n …)`: chỉ khi bạn trả lời **y** thì Mac mới mở trình duyệt (một địa chỉ cố định, chỉ trong Terminal thật). Bước 2 hỏi `api_id` (chỉ chữ số) rồi `api_hash` (32 ký tự `0-9` `a-f`; khi gõ/dán chỉ hiện `••••`, không hiện giá trị thật). Gõ sai thì có thông báo dễ hiểu (dán nhầm `api_hash` vào ô `api_id` và ngược lại, sai độ dài…). Gõ `b` hoặc Enter ở các ô này để quay lại. Bước 3: chọn quét QR hoặc số điện thoại + mã; quét xong màn hình ghi tên tài khoản đã liên kết kèm số điện thoại **đã che bớt** (không bao giờ hiện phiên đăng nhập).

   - *Chờ quét QR / kết nối*: dòng quay `⠋ Connecting to Telegram...` và `⠋ Waiting for you to scan the code...` (chỉ trên Terminal; khi chạy qua pipe hoặc ghi log không in gì thêm).
   - *Telegram từ chối*: mỗi lỗi là một câu dễ hiểu, ví dụ `Telegram rejected the api_id / api_hash (API_ID_INVALID). Copy both values again from https://my.telegram.org/apps, …`; `FLOOD_WAIT` cho biết phải đợi bao lâu.
   - *Đang kiểm tra* (menu `1`): một dòng thanh tiến trình vẽ lại tại chỗ:

     ```text
     ⠹ ████████░░░░░░░░░░░░░░░░░░░░  27% 30/108  telegram 12/36 · whatsapp 12/36 · zalo 6/36
     ```

     gồm phần trăm, đã xong/tổng, số của từng app, thời gian còn lại ước tính (`ETA`, chỉ hiện sau vài giây) và, khi tài khoản đang nghỉ, `pacing 4 s` hoặc `resting until 14:05`. Ctrl-C một lần: dừng gọn và lưu báo cáo.
   - *Kết quả*: bảng tóm tắt có màu (`yes` xanh lá, `not_found` vàng, `invalid` đỏ, `unknown`/`skipped` mờ), rồi khung cuối:

     ```text
     ╭─ Report saved to /tmp/ux/report.csv ──────────────────────────────
     │ ⚠ INCOMPLETE: the report is NOT final. Numbers without a fresh
     │ answer: 18.
     │ Run the same check again with the same file to continue; finished
     │ numbers are not repeated.
     │
     │ Next: open the file with Excel or Numbers (double-click it).
     │ To show it in Finder, type: open -R '/tmp/ux/report.csv'
     ╰───────────────────────────────────────────────────────────────────
     ```

     Nếu mọi số đã có kết quả thì khung màu xanh và không có phần `INCOMPLETE`; nếu còn số chưa có kết quả thì khung màu vàng, dòng cảnh báo **đậm, đỏ**, và báo cáo **chưa phải bản cuối**: chạy lại đúng lệnh cũ để tiếp tục (số đã xong không bị hỏi lại). Đường dẫn quá dài được cắt bên trái (`…/Khách hàng/report.csv`) để khung không bị gãy; đường dẫn đầy đủ nằm ở dòng `Report written to …` ngay phía trên.

---

## Mục lục

1. [Bạn cần gì](#1-bạn-cần-gì)
2. [Kiểm tra file tải về](#2-kiểm-tra-file-tải-về)
3. [Giải nén](#3-giải-nén)
4. [Cài đặt](#4-cài-đặt)
5. [Cấu hình lần đầu và `doctor`](#5-cấu-hình-lần-đầu-và-doctor)
6. [Đăng nhập tài khoản cho từng ứng dụng](#6-đăng-nhập-tài-khoản-cho-từng-ứng-dụng)
7. [File danh sách số (CSV)](#7-file-danh-sách-số-csv)
8. [Chạy kiểm tra, xem báo cáo, xem tài khoản](#8-chạy-kiểm-tra-xem-báo-cáo-xem-tài-khoản)
9. [Đọc kết quả trong báo cáo](#9-đọc-kết-quả-trong-báo-cáo)
10. [Dữ liệu nằm ở đâu](#10-dữ-liệu-nằm-ở-đâu)
11. [Quyền riêng tư và an toàn](#11-quyền-riêng-tư-và-an-toàn)
12. [Cách thử nghiệm đề xuất và gửi kết quả về](#12-cách-thử-nghiệm-đề-xuất-và-gửi-kết-quả-về)
13. [Cập nhật, quay lại bản cũ, gỡ cài đặt](#13-cập-nhật-quay-lại-bản-cũ-gỡ-cài-đặt)
14. [Sự cố thường gặp](#14-sự-cố-thường-gặp)

---

## 1. Bạn cần gì

- Mac chip **Apple Silicon** (M1, M2, M3, M4…) – kiểm tra: menu Apple  → *About This Mac* (Giới thiệu về máy Mac này) → dòng **Chip** phải ghi "Apple M…". Mac Intel **không** chạy được bản này.
- **macOS 13.5 trở lên** (menu Apple → *About This Mac* → số phiên bản; hoặc gõ `sw_vers -productVersion` trong Terminal). Mức 13.5 do chính Node.js đi kèm quy định; mọi file thực thi trong gói đã được kiểm tra khai báo yêu cầu tối thiểu ≤ 13.5, nhưng đó chỉ là kiểm tra thông tin trong file – **chưa chạy thật trên macOS 13.5** (chỉ chạy thử trên macOS 27). Nếu máy bạn là macOS 13.x hay 14.x, hãy ghi rõ phiên bản khi gửi kết quả (mục 12).
- Ứng dụng Terminal (có sẵn trong macOS). Nếu Terminal của bạn đang chạy ở chế độ Rosetta (Intel), hãy tắt chế độ đó (xem mục 14).
- Khoảng 600 MB dung lượng trống (file tải về ~65 MB, thư mục giải nén ~240 MB, bản đã cài ~240 MB; có thể xóa file tải và thư mục giải nén sau khi cài xong).
- Mỗi ứng dụng cần kiểm tra cần có **tài khoản riêng** và điện thoại/SIM của tài khoản đó ở bên cạnh lúc đăng nhập lần đầu (nhận mã, quét QR).
- **Chỉ Viber**: thêm một máy Android (hoặc máy ảo Android) và công cụ **`adb`** (Android platform-tools). `adb` **không** nằm trong file tải về. Viber là phần thiết lập kỹ thuật phức tạp (vài giờ) – nên để sau, xem mục 6.4. Bỏ qua Viber vẫn dùng được 4 ứng dụng còn lại.

## 2. Kiểm tra file tải về

Bạn nhận được hai file đặt cùng một chỗ (ví dụ thư mục *Downloads*):

- `phone-app-checker-0.1.0-macos-arm64.tar.gz`
- `phone-app-checker-0.1.0-macos-arm64.tar.gz.sha256`

Kiểm tra file không bị hỏng hoặc bị sửa trên đường chuyển:

```sh
cd ~/Downloads
shasum -a 256 -c phone-app-checker-0.1.0-macos-arm64.tar.gz.sha256
```

Kết quả đúng:

```
phone-app-checker-0.1.0-macos-arm64.tar.gz: OK
```

Nếu thấy `FAILED` hoặc `No such file`: **dừng lại**, không giải nén. Xin gửi lại file (hoặc đảm bảo bạn đang đứng trong thư mục chứa file – lệnh `cd` ở trên).

> `.sha256` chỉ phát hiện file bị lỗi/bị đổi *so với file `.sha256` đi kèm*. Chỉ nhận cả hai file từ chính người gửi bản này.

> Lần đầu Terminal đọc file trong *Downloads*, macOS có thể hỏi "Terminal would like to access files in your Downloads folder" – bấm **Allow**. Nếu lỡ từ chối hoặc gặp `Operation not permitted`: xem mục 14.

## 3. Giải nén

Cách 1 (Finder): bấm đúp vào file `.tar.gz` trong *Downloads*. Một thư mục `phone-app-checker-0.1.0-macos-arm64` xuất hiện.

Cách 2 (Terminal):

```sh
cd ~/Downloads
tar -xzf phone-app-checker-0.1.0-macos-arm64.tar.gz
```

Thư mục chứa: `install.sh`, `uninstall.sh`, `INSTALL.md` (bản tiếng Anh), `INSTALL.vi.md` (chính tài liệu này), `LICENSE`, `THIRD_PARTY_LICENSES.md`, `VERSION`, `phone-app-checker`, `runtime/` (Node.js kèm sẵn) và `app/`.

## 4. Cài đặt

```sh
bash ~/Downloads/phone-app-checker-0.1.0-macos-arm64/install.sh
```

> Chạy bằng lệnh `bash …` như trên. **Đừng bấm đúp vào `install.sh`** trong Finder – macOS có thể chặn hoặc mở nó bằng ứng dụng khác.

Trình cài đặt, không cần mật khẩu quản trị (không dùng `sudo`):

1. Kiểm tra máy: chip Apple Silicon (không phải Terminal Rosetta), macOS ≥ 13.5. Không đạt → in lý do và dừng, chưa thay đổi gì.
2. Giữ "khóa bảo trì" cho tới khi cài xong: trong lúc đó không lệnh `phone-app-checker` nào chạy hoặc mở được dữ liệu, và nếu đang có lệnh chạy thì trình cài đặt đợi tối đa ~3 giây rồi **từ chối** (mục 14).
3. Chép chương trình vào thư mục tạm cạnh nơi cài rồi mới thay vào `~/Applications/phone-app-checker/0.1.0`. Bản cũ cùng số phiên bản (nếu có) **được giữ lại cho tới khi bản mới chạy được `phone-app-checker --version`**; lỗi hoặc bị ngắt giữa chừng thì quay về bản cũ.
4. Gỡ dấu "tải từ Internet" (quarantine) của macOS khỏi bản đã cài, để Gatekeeper không chặn.
5. Tạo lệnh `phone-app-checker` tại `~/.local/bin` và, nếu cần, thêm một đoạn nhỏ vào `~/.zprofile` (hoặc `~/.bash_profile`) để Terminal tìm thấy lệnh. File shell được ghi sang file tạm cùng thư mục rồi đổi tên đè lên (giữ nguyên quyền, không bao giờ bị cắt ngắn giữa chừng). Đoạn này nằm giữa hai dòng `# >>> phone-app-checker >>>` và `# <<< phone-app-checker <<<` và sẽ bị xóa khi gỡ cài đặt.
6. Chạy `phone-app-checker --version` và `phone-app-checker doctor` (xem mục 5).

Cuối cùng trình cài đặt in đường dẫn đã cài, đường dẫn file cấu hình, và cách xóa các bản cũ nếu có. **Dòng tóm tắt đầu tiên không bao giờ là lời khẳng định "xong"**:

- Nếu `doctor` không có `FAIL`, nó in `Đã chép file / Files installed: phone-app-checker 0.1.0 (doctor: không có FAIL / no FAIL)` cùng dòng `NOT yet trustworthy: doctor checks offline readiness only. Run login, then a small trial with known-truth numbers.` – nghĩa là mới chép xong file; **chưa** đăng nhập, **chưa** thử với đáp án đã biết (mục 6 và 12).
- Nếu `doctor` báo `FAIL`, nó in `CHƯA SẴN SÀNG / NOT READY: phone-app-checker 0.1.0 đã được chép vào máy nhưng doctor báo FAIL (mã / exit 1).` Các file vẫn nằm trên máy nên `install.sh` thoát với mã `0`; **đừng** coi mã thoát đó là "dùng được" – sửa mọi dòng `FAIL` ở trên rồi chạy lại `phone-app-checker doctor` cho tới khi không còn `FAIL`.

Khi gỡ cài đặt, đoạn PATH trong `~/.zprofile`/`~/.bash_profile` chỉ bị xóa nếu hai dòng đánh dấu còn **nguyên văn** (không thêm khoảng trắng hay ghi chú ở cuối dòng) và đi thành từng cặp. Nếu bạn đã sửa chúng, chương trình **không đụng vào** file đó và in hướng dẫn: tự xóa các dòng từ `# >>> phone-app-checker >>>` đến `# <<< phone-app-checker <<<`. Nếu `~/.zprofile` (hoặc `~/.bash_profile`) **do chính trình cài đặt tạo ra** (trước đó chưa có file) và sau khi bỏ đoạn PATH file trở nên trống, file trống đó cũng được xóa; file có sẵn từ trước (kể cả file trống) hoặc còn nội dung khác thì **luôn được giữ nguyên**. Việc nhớ "file do trình cài đặt tạo" nằm trong `~/Applications/phone-app-checker/.created-profiles` (bị xóa cùng thư mục cài đặt).

**Mở cửa sổ Terminal mới** (hoặc đóng và mở lại Terminal), rồi thử:

```sh
phone-app-checker --version
```

Phải in `0.1.0`. Nếu báo `command not found` xem mục 14.

Sau đó gõ `phone-app-checker` (không thêm gì) để mở menu – xem "Cách dùng nhanh" ở đầu tài liệu. Các mục 5 đến 8 mô tả cùng các việc đó bằng lệnh gõ tay, dùng được song song với menu.

Cài lại cùng lệnh nhiều lần là an toàn. Trong lúc **bất kỳ** lệnh `phone-app-checker` nào đang chạy (`check`, `login`, `report`, `accounts`, `account-reset`, `doctor`) việc cài, cài lại hoặc gỡ cài đặt đều **bị từ chối** (sau ~3 giây chờ, có ghi số pid); ngược lại, khi đang cài/gỡ thì các lệnh đó từ chối chạy. Đợi bên kia xong rồi làm lại (mục 14). **Nếu lần cài bị ngắt đột ngột** (mất điện, buộc đóng Terminal bằng cách tắt nguồn/`kill -9`): chạy lại `install.sh` ngay sẽ **bị từ chối** vì file khóa `maintenance.lock` (trong `~/Library/Application Support/phone-app-checker-lifecycle/`) còn sót – thông báo lỗi ghi rõ đường dẫn file đó. Làm đúng thứ tự: (1) chắc chắn không còn `install.sh`/`uninstall.sh`/lệnh `phone-app-checker` nào đang chạy (`ps aux | grep phone-app-checker`; sau khi khởi động lại máy thì chắc chắn không còn); (2) xóa file `maintenance.lock` mà thông báo nêu (`rm ~/Library/Application\ Support/phone-app-checker-lifecycle/maintenance.lock`) – chương trình **cố ý không tự xóa** file này; (3) chạy lại `install.sh` từ gói đã tải – lúc đó nó tự khôi phục bản cũ còn sót lại (`~/Applications/phone-app-checker/.replaced.<phiên bản>.*`) và dọn thư mục tạm `.incoming.*`. Trong lúc chờ, `phone-app-checker --version` vẫn chạy được, còn các lệnh khác từ chối chạy và nói rõ file cần xóa. Nếu đã có một lệnh `phone-app-checker` khác không phải của chương trình này trong `~/.local/bin`, trình cài đặt dừng lại và không ghi đè – đổi tên hoặc xóa nó rồi chạy lại.

## 5. Cấu hình lần đầu và `doctor`

Lần chạy đầu tiên chương trình tự tạo thư mục dữ liệu và file cấu hình:

```
~/Library/Application Support/phone-app-checker/checker.config.json
```

Mở file bằng TextEdit:

```sh
open -e ~/Library/Application\ Support/phone-app-checker/checker.config.json
```

> **Quan trọng – tắt "Smart Quotes" trước khi gõ.** TextEdit mặc định tự đổi dấu nháy thẳng `"` thành nháy cong `“ ”`; file JSON sẽ hỏng (`doctor` báo `FAIL config … curly quotes at line …`). Trong TextEdit: menu *Edit → Substitutions* → bỏ chọn **Smart Quotes** (và **Smart Dashes**), rồi mới gõ. Cách khác, không cần TextEdit: dùng `nano ~/Library/Application\ Support/phone-app-checker/checker.config.json` (lưu: Ctrl+O rồi Enter; thoát: Ctrl+X). Nếu bạn dán `apiHash` từ trang web, hãy dán vào giữa hai dấu `"` thẳng đã có sẵn thay vì gõ lại dấu nháy.

> **File cấu hình phải là văn bản thuần (plain text), tên đúng `checker.config.json`, đuôi `.json`.** TextEdit có thể lưu dạng *Rich Text*: nếu menu *Format* có mục **Make Plain Text** (Shift + Cmd + T) thì bấm trước khi lưu. Đừng để TextEdit thêm đuôi `.rtf` hoặc `.txt` (ví dụ `checker.config.json.txt` là một file khác, chương trình không đọc nó và vẫn dùng file cũ). `nano` (ở trên) là cách ít rủi ro nhất.

Những chỗ bạn thường cần sửa:

**a) Telegram `apiId` / `apiHash`** (bắt buộc nếu dùng Telegram). **Cách dễ nhất: không cần sửa file** – menu 2 → Telegram hỏi hai giá trị này và tự lưu (mục 6.1). Nếu muốn điền tay: lấy tại <https://my.telegram.org/apps> bằng số điện thoại của tài khoản kiểm tra (hướng dẫn chi tiết: mục 6.1). Điền vào đúng chỗ này – `apiId` là số (không có dấu nháy), `apiHash` nằm trong dấu nháy kép:

```json
"telegram": {
  "enabled": true,
  "options": {
    "apiId": 1234567,
    "apiHash": "0123456789abcdef0123456789abcdef"
  }
}
```

(Trong file thật, các khóa khác như `batchSize`, `dailyCap` nằm cùng khối `telegram` – giữ nguyên, chỉ sửa `apiId` và `apiHash`.)

**b) Bật/tắt từng ứng dụng** bằng `"enabled": true` hoặc `false`. Mặc định: Telegram, WhatsApp, Zalo **bật**; Viber, LINE **tắt**.

**c) `defaultRegion`** (mặc định `"VN"`): quốc gia dùng cho các số viết không có mã nước, ví dụ `0901234567`.

Quy tắc khi sửa file JSON: giữ nguyên dấu `"` `,` `{` `}` (dấu nháy phải là nháy thẳng); không để dấu phẩy thừa ở phần tử cuối. Sai cú pháp → `doctor` báo `FAIL config` kèm vị trí (dòng, cột) – chương trình cố ý không in lại nội dung file để không lộ `apiHash`. Các khóa **bên ngoài mục `options`** mà không có trong file mẫu bị từ chối (để lỗi gõ sai không bị bỏ qua); trong `options` bạn được thêm các tùy chọn của ứng dụng (ví dụ `adbPath` cho Viber). `batchSize`, `dailyCap` phải là số nguyên ≥ 1; `defaultRegion` phải là mã nước thật (`VN`, `GB` – **không** phải `UK`); thời gian tính bằng mili-giây và tối đa một năm; `dataDir` không được để trống. File lưu từ Notepad (có BOM) vẫn đọc được. Muốn quay lại bản gốc: đổi tên file cấu hình hiện tại (ví dụ thêm `.bak`) rồi chạy lại `phone-app-checker doctor` – chương trình tạo lại file mới.

Lưu file (Cmd + S), rồi chạy:

```sh
phone-app-checker doctor
```

`doctor` in một bảng, mỗi dòng gồm mức, tên mục và chi tiết:

| Mức | Nghĩa | Việc cần làm |
| --- | --- | --- |
| `OK` | Mục này sẵn sàng. | Không. |
| `WARN` | Chưa làm xong một bước thiết lập (ví dụ chưa nhập `apiId`/`apiHash`, chưa đăng nhập tài khoản nào, chưa thấy thiết bị Android cho Viber). **Vẫn chạy được**, chỉ ứng dụng đó chưa dùng được. | Làm theo gợi ý ở cuối dòng. Lần đầu cài, các dòng `WARN` là bình thường. |
| `FAIL` | Chương trình không chạy được (file cấu hình sai, thư mục dữ liệu bị lỗi quyền, thiếu `adb` khi đã bật Viber, …). | Sửa theo chi tiết ghi trên dòng đó rồi chạy lại `doctor`. |

`doctor` thoát với lỗi chỉ khi có `FAIL`. Lặp lại cho tới khi **không còn `FAIL`**. Dòng của cả năm ứng dụng (telegram, whatsapp, zalo, viber, line) đều có mặt, kể cả ứng dụng đang tắt – `OK … disabled (module loads)` nghĩa là chương trình đã nạp được mô-đun của ứng dụng đó.

**`doctor` chỉ cho biết máy đã sẵn sàng *offline*** (máy, cấu hình, thư mục dữ liệu, mô-đun nạp được, có thư mục tài khoản). `OK` **không** có nghĩa là tài khoản còn đăng nhập hay ứng dụng còn trả lời đúng – điều đó chỉ biết sau khi bạn `login` và chạy thử file ~20 số có đáp án đã biết (mục 12). `doctor` không đọc số điện thoại nào và không mở kết nối tới ứng dụng nhắn tin. Vì vậy `doctor` **luôn** kết thúc bằng đúng ba dòng sau (dù có `FAIL` hay không):

```
NOTE: doctor checks offline readiness only (no live account authentication).
OK does not prove an account can check numbers: run `phone-app-checker login <app> --account <name>`,
then a small trial on numbers whose answers you already know, before trusting any result.
```

Nghĩa tiếng Việt: *doctor chỉ kiểm tra độ sẵn sàng offline (không xác thực tài khoản thật); `OK` chưa chứng minh tài khoản kiểm tra được số – phải `login`, rồi chạy thử một lô nhỏ có đáp án đã biết trước khi tin bất kỳ kết quả nào.* Việc chạy `doctor` lần đầu cũng tạo thư mục `data/` trong thư mục dữ liệu (mục 10).

## 6. Đăng nhập tài khoản cho từng ứng dụng

Mỗi tài khoản đăng nhập **một lần**; phiên đăng nhập được lưu lại, lần sau không hỏi nữa. Đặt cho mỗi tài khoản một tên ngắn (`--account`): 1–32 ký tự gồm chữ, số, `-`, `_` (ví dụ `tg1`, `wa1`). Có thể đăng nhập nhiều tài khoản cho một ứng dụng để chia tải. Phải chạy trong Terminal thật (có bàn phím tương tác), mỗi lần một lệnh `login`.

Kiểm tra bất cứ lúc nào:

```sh
phone-app-checker accounts
```

Dòng mỗi tài khoản cho biết `ready` (sẵn sàng), `cooling down until …` (đang nghỉ, xem mục 14 "Bị giới hạn tốc độ") hoặc `DISABLED: <lý do>` (cần người xử lý).

Hướng dẫn chi tiết, lời nhắc và ý nghĩa lỗi của từng ứng dụng nằm trong thư mục tài liệu đã cài: `~/Applications/phone-app-checker/current/app/docs/`. Mở bằng: `open ~/Applications/phone-app-checker/current/app/docs`.

### 6.0 Nếu mã QR không hiện hoặc không quét được

- Mã QR được vẽ bằng **màu cố định** (đen tuyệt đối trên nền trắng, có viền trắng quanh mã) nên quét được ở cả giao diện Terminal nền tối lẫn nền sáng. Hãy giữ điện thoại cách màn hình một quãng vừa phải và để màn hình đủ sáng.
- Mã WhatsApp cao khoảng 35 dòng và rộng khoảng 70 cột. Nếu cửa sổ Terminal quá nhỏ (cửa sổ mặc định 80x24 là **không đủ**), chương trình **không** vẽ mã bị cắt/gãy mà in dòng báo cần bao nhiêu cột x dòng: hãy **kéo to cửa sổ** (hoặc bấm nút phóng to màu xanh) hoặc nhấn **Cmd + dấu trừ** để thu nhỏ chữ. Mã sẽ tự hiện ra khi cửa sổ đủ lớn.
- Mã đổi liên tục (WhatsApp ~20 giây, Telegram ~30 giây): mã mới thay mã cũ ngay tại chỗ. Quét mã đang hiện.
- Nếu đặt biến `NO_COLOR` hoặc chạy không phải Terminal, chương trình in bản chữ `##` kèm ghi chú: bản này chỉ đúng với giao diện **nền sáng**.

### 6.1 Telegram

Menu **2 → Telegram** làm hết các bước sau, không cần sửa file:

1. **Bước 1/3 – lấy khóa (một lần, miễn phí).** Nếu chưa có `api_id` / `api_hash`, menu nói rõ vì sao cần khóa, in địa chỉ <https://my.telegram.org/apps> và hỏi có mở trang đó trong trình duyệt không (trả lời `y`; chỉ khi bạn đồng ý mới mở). Trên trang: đăng nhập bằng số của tài khoản kiểm tra, điền form (**App title** và **Short name** gõ gì cũng được, ví dụ `Checker` và `checker1`; **Platform** chọn `Other`; để trống các ô còn lại) rồi bấm **Create application**. Chép `api_id` (số ngắn) và `api_hash` (32 ký tự).
2. **Bước 2/3 – lưu khóa.** Gõ/dán `api_id` (chỉ chữ số), rồi `api_hash` (đúng 32 ký tự `0-9` `a-f`): `api_hash` **không hiện giá trị khi gõ** (chỉ hiện `••••` để biết đã dán được) và không bao giờ được in lại. Gõ `b` hoặc Enter để quay lại ở bất kỳ ô nào. Menu kiểm tra định dạng, báo lỗi dễ hiểu nếu nhầm, rồi lưu vào file cấu hình (ghi nguyên tử, quyền 600, các mục khác giữ nguyên). Đã có khóa rồi thì menu ghi `API keys found` và bỏ qua hai bước này. *(Vẫn dùng được cách cũ: điền tay ở mục 5a, hoặc đặt biến môi trường `TELEGRAM_API_ID` / `TELEGRAM_API_HASH`; giá trị trong file được ưu tiên.)*
3. **Bước 3/3 – quét QR (hoặc số điện thoại + mã).** `1)` quét mã QR bằng app Telegram (mặc định): *Cài đặt → Thiết bị → Liên kết thiết bị máy tính*, hoặc `2)` nhập số điện thoại rồi mã Telegram gửi về. Mã QR Telegram đổi khoảng 30 giây một lần (mã mới thay mã cũ). Nếu tài khoản có mật khẩu xác minh 2 bước, chương trình hỏi sau khi quét (gõ không hiện ký tự). Quét xong, màn hình ghi tên tài khoản và số điện thoại đã che bớt. Không ai quét trong 5 phút → báo lỗi, chạy lại. Với cách 2: số điện thoại dạng quốc tế (`+84…`) → mã Telegram gửi về (gõ không hiện ký tự) → mật khẩu 2 bước nếu có.

Dùng lệnh trực tiếp: `phone-app-checker login telegram --account tg1 --method qr` (hoặc không có `--method` để nhập số điện thoại + mã). Ctrl-C để hủy.

Tài khoản mới tinh rất dễ bị Telegram hạn chế: hãy dùng bình thường vài ngày trước khi kiểm tra hàng loạt.

### 6.2 WhatsApp

```sh
phone-app-checker login whatsapp --account wa1
```

Menu **2** hỏi: `1)` liên kết bằng số điện thoại: nhập mã ghép đôi 8 ký tự trên điện thoại (**khuyên dùng**, mặc định, Enter) hay `2)` quét mã QR.

- **Mã ghép đôi (khuyên dùng):** menu hỏi số điện thoại của tài khoản WhatsApp cần liên kết (kèm mã nước; số sai thì hỏi lại), rồi in mã 8 ký tự dạng `ABCD-1234`. Trên điện thoại: *WhatsApp → Cài đặt → Thiết bị đã liên kết → Liên kết thiết bị → Liên kết bằng số điện thoại*, rồi nhập mã. Không cần sửa file cấu hình. Dùng lệnh trực tiếp: `phone-app-checker login whatsapp --account wa1 --method code --phone +84901234567`. Xong, menu in `Logged in...` một lần và nhắc **chọn 1 để kiểm tra file CSV**.
- **QR:** Terminal in mã **QR** (xem 6.0). Mã đầu dùng được ~60 giây, các mã sau ~20 giây; mã mới thay mã cũ. Từ 28/07/2026 WhatsApp yêu cầu mã mới ngay sau khi quét; chương trình xử lý việc này (điện thoại có thể báo lỗi một lần, hãy quét mã mới hiện ra). **Chưa xác nhận bằng điện thoại thật**: nếu QR vẫn báo lỗi, dùng mã ghép đôi.

### 6.3 Zalo (chỉ số Việt Nam `+84`)

```sh
phone-app-checker login zalo --account z1
```

Terminal **vẽ mã QR ngay trong cửa sổ** – không cần mở file ảnh. Trong Zalo bấm biểu tượng quét QR cạnh thanh tìm kiếm, quét mã rồi xác nhận đăng nhập trên điện thoại. Chương trình báo "đã quét", "hết hạn" (mã hết hạn sau khoảng 100 giây và tự tạo lại tối đa 3 lần, mã mới thay mã cũ) hoặc "bị từ chối". Chỉ khi không đọc được ảnh QR mới quay về cách cũ: in đường dẫn ảnh `login-qr.png` (quyền 600, trong thư mục tài khoản, xóa sau khi xong) và tự mở ảnh trên Mac. Số không phải `+84` sẽ để `skipped` cho cột Zalo.

### 6.4 Viber (tùy chọn, kỹ thuật)

Viber không có cách tra cứu chính thức. Chương trình điều khiển ứng dụng Viber **thật trên máy Android** (máy ảo "Google APIs" hoặc điện thoại đã root) qua `adb`, rồi đọc cơ sở dữ liệu của Viber. Cần:

- Công cụ `adb` cài sẵn trên Mac và gọi được (`adb version`). Nếu `adb` không nằm trong PATH, khai báo đường dẫn đầy đủ ở `apps.viber.options.adbPath`.
- Máy Android có root, Viber đã kích hoạt bằng SIM riêng, đồng bộ danh bạ bật.
- **Ba câu SQL (`registeredQuery`, `syncedQuery`, `authQuery`) phải tự tìm cho đúng phiên bản Viber đang cài**; file mẫu chỉ có chỗ giữ chỗ cố ý không chạy được. Script hỗ trợ tìm: `~/Applications/phone-app-checker/current/app/scripts/viber-discover-schema.sh`.
- Tắt tự cập nhật Viber (cấu trúc dữ liệu đổi giữa các phiên bản).

Đây là việc của người kỹ thuật; đọc `~/Applications/phone-app-checker/current/app/docs/viber-setup.md`. Chỉ đặt `"enabled": true` cho Viber khi đã làm xong. Khi đã bật Viber mà thiếu `adb`, `doctor` báo `FAIL`; bật mà chưa thấy thiết bị Android thì `WARN`. Sau khi cấu hình xong:

```sh
phone-app-checker login viber --account vb1
```

Lệnh này **chỉ kiểm tra** thiết lập máy Android/`adb` có đúng không, không đăng nhập thay bạn.

### 6.5 LINE

Số điện thoại chỉ tra cứu có ý nghĩa ở Hồng Kông, Nhật, Hàn Quốc, Đài Loan, Thái Lan (và tài khoản LINE cũ trước phiên bản 13.11); ở nơi khác `not_found` gần như không có thông tin. Đặt `"enabled": true` cho LINE trong file cấu hình, rồi:

```sh
phone-app-checker login line --account l1
```

Mặc định hiện mã QR trong Terminal (cùng bộ vẽ mã với WhatsApp/Zalo/Telegram, xem mục 6.0): quét bằng ứng dụng LINE trên điện thoại của tài khoản, rồi nhập mã PIN hiển thị trong Terminal lên điện thoại. Chế độ thay thế `"loginMode": "password"` (e-mail + mật khẩu) đặt trong `apps.line.options`.

## 7. File danh sách số (CSV)

Tạo một thư mục làm việc riêng **trong thư mục home của bạn, không đồng bộ** và để file danh sách ở đó:

```sh
mkdir -p ~/phone-checks
cd ~/phone-checks
```

> **Đừng để file khách hàng trong `Documents`, `Desktop`, iCloud Drive, Dropbox, Google Drive…** Trên nhiều máy `Desktop` và `Documents` tự đồng bộ lên iCloud (kể cả khi bạn không nhớ đã bật), tức là số điện thoại khách bị chép lên dịch vụ bên thứ ba; macOS cũng hỏi quyền riêng cho Terminal khi đọc các thư mục đó (mục 14, `Operation not permitted`). `~/phone-checks` không rơi vào hai trường hợp này. Muốn dùng *Downloads* hay *Desktop* chỉ để nhận file thì chép sang `~/phone-checks` rồi xóa bản gốc.

File là CSV (xuất từ Excel/Numbers: *Save As / Export → CSV UTF-8*), một dòng một khách. Ví dụ `customers.csv`:

```csv
name,phone
An,0901234567
Binh,+84 90 765 4321
Chi,+82 10-1234-5678
```

- Cột số điện thoại tự nhận diện qua tên tiêu đề (`phone`, `SĐT`, `mobile`, …) hoặc cột có nội dung giống số điện thoại. Chỉ định tay: `--column phone` hoặc `--column 2` (cột thứ 2, đếm từ 1).
- Dấu phân cách `,` `;` hoặc Tab, kết thúc dòng kiểu Windows/Mac cũ, file UTF-8 có BOM và cả *Unicode Text* của Excel (UTF-16 có BOM) đều được xử lý. File `.xlsx` (không phải CSV) hoặc UTF-16 không BOM sẽ bị từ chối kèm hướng dẫn lưu lại bằng *CSV UTF-8*. Nếu dòng đầu có số dấu `,` và `;` bằng nhau và các dòng sau không phân định được, chương trình dừng với `Cannot tell how the columns are separated` thay vì đoán: lưu lại bằng *CSV UTF-8 (Comma delimited)*, tiêu đề cột đơn giản, hoặc chỉ giữ cột số điện thoại.
- Số không có mã nước (ví dụ `0901234567`) hiểu theo `defaultRegion` (mặc định Việt Nam). Số quốc tế nên viết đầy đủ `+mã_nước…`.
- **Cẩn thận Excel – nguyên nhân số một của số sai:**
  - **Đặt cột số điện thoại ở dạng *Text* trước khi dán/nhập số** (chọn cột → *Format Cells → Text*; khi mở một file `.csv` bằng *Data → From Text/CSV* thì chọn kiểu *Text* cho cột đó). Nếu không, Excel bỏ số `0` đầu (`0901…` thành `901…`; tool vẫn hiểu `901234567` là số Việt Nam theo `defaultRegion`) và đổi số dài thành dạng khoa học (`8.49E+10`).
  - Xuất bằng **CSV UTF-8 (Comma delimited)**.
  - Chữ số đã mất vì dạng khoa học **không khôi phục được**: chương trình ghi `invalid`, không đoán. Hãy xuất lại từ bản gốc còn đủ số, đừng tự điền lại chữ số thiếu.
  - Viết số dạng `+84…` cũng tránh được phần lớn lỗi.
- Số trùng chỉ kiểm tra một lần. Ô không phải số điện thoại hợp lệ được ghi `invalid`.
- Nếu **không có số hợp lệ nào** (chọn nhầm cột, toàn `invalid`), `check` dừng ngay với mã thoát `1`: `no valid phone numbers (N invalid); check --column …` và **không** tạo báo cáo. Đây là lỗi, không phải "chạy xong".
- Tên và các cột khác trong file đầu vào **không** được đưa vào báo cáo; báo cáo chỉ có cột `input` (nội dung ô số gốc) cùng cột kết quả.

## 8. Chạy kiểm tra, xem báo cáo, xem tài khoản

Luôn đứng trong thư mục làm việc (mục 7). Kéo file vào cửa sổ Terminal cũng điền sẵn đường dẫn.

> Không muốn nhớ lệnh? Gõ `phone-app-checker` không kèm gì để dùng menu (mục 1 của menu = `check`, 3 = `accounts`, 4 = `report`, 5 = `doctor`).

**Lần đầu: chạy lô nhỏ, có người ngồi cạnh**, bằng file ~20 số nhân viên mà bạn biết rõ có/không có từng ứng dụng (mục 12) – **không** dùng danh sách khách thật:

```sh
phone-app-checker check staff.csv --apps telegram --out staff-telegram.csv --no-wait
```

- `--no-wait`: nếu mọi tài khoản đều đang nghỉ hoặc hết hạn mức trong ngày thì **dừng** (in `Next resume: …` – thời điểm chạy lại được) thay vì ngủ chờ nhiều ngày.
- **Cắm điện** và đừng gập máy. **Khi Mac ngủ, tiến trình bị đóng băng** (không kiểm tra gì, nhưng đồng hồ vẫn trôi); nó tiếp tục khi máy thức.
- Muốn dừng: bấm **Ctrl-C đúng một lần rồi đợi** – chương trình hoàn tất lô hiện tại, ghi báo cáo rồi thoát (mã 130); có thể mất từ vài chục giây tới vài phút. Đừng bấm lần hai, đóng cửa sổ hay buộc thoát (Force Quit/`kill -9`): kết quả đã lưu không mất, nhưng lô đang chạy có thể bị hỏi lại và danh bạ tạm trên tài khoản Telegram/Viber có thể còn sót (mục 12 bước C). Chạy lại cùng lệnh để tiếp tục.

Sau khi thử nhỏ đạt (mục 12), chạy danh sách thật:

```sh
phone-app-checker check customers.csv --out report.csv
```

- Giới hạn một số ứng dụng: `--apps telegram,zalo` (các cột ứng dụng khác ghi `skipped`).
- `--max-age 7`: dùng lại kết quả `yes`/`not_found` trẻ hơn 7 ngày; `--max-age 0`: kiểm tra lại tất cả. Mặc định theo `maxAgeDays` trong cấu hình (30 ngày). Kết quả mang ngày ở **tương lai** (đồng hồ máy bị chỉnh lùi) không bao giờ được dùng lại, kể cả khi `--max-age` rất lớn.
- `--out` không được trùng file đầu vào; file báo cáo cũ của chính công cụ này sẽ được ghi đè, file lạ cùng tên sẽ bị từ chối trừ khi có `--force` (đừng dùng `--force` trừ khi chắc chắn).
- Tiến độ và kết quả lưu vào cơ sở dữ liệu sau **mỗi lô**. Chạy lại cùng lệnh sẽ tiếp tục chỗ dừng; số đã có kết quả mới không bị hỏi lại. Một lần kiểm tra lại không có trả lời **không** ghi đè kết quả `yes`/`not_found` cũ – nhưng nó cũng **không** làm kết quả cũ thành mới: xem cột `<app>_checked_at` và `<app>_stale` (mục 9). Các số nằm trong một lô bị lỗi được nhớ lại, lần chạy sau kiểm tra chúng **sau cùng và từng số một** để những số lành lặn đi cùng lô được trả lời.
- Mỗi tài khoản có hạn mức ngày (`dailyCap`) và quãng nghỉ giữa các lô (`minIntervalMs`). **Thông lượng mỗi ngày ≈ số tài khoản × `dailyCap`**: 1 tài khoản Telegram với `dailyCap` mặc định 200 mất ~50 ngày cho 10 000 số. Khi mọi tài khoản hết hạn mức mà không có `--no-wait`, lệnh `check` **ngủ chờ**, có thể nhiều ngày. Muốn Mac không tự ngủ: `caffeinate -i phone-app-checker check customers.csv --out report.csv` (giữ Mac cắm điện, không gập máy).
- **Đọc kết thúc lệnh, đừng chỉ nhìn mã thoát.** Mã `0` chỉ nghĩa là lệnh chạy xong và ghi được báo cáo – **không** có nghĩa mọi số đã có kết quả mới (`130` nếu bị ngắt, `1` nếu lỗi hoặc không có số hợp lệ). Mỗi ứng dụng có một dòng `needed N, attempted …, conclusive …, inconclusive …`; nếu còn số chưa có kết quả mới, cuối màn hình có khung **INCOMPLETE** (mục 9).

Dựng lại báo cáo từ kết quả đã lưu, **không dùng mạng**, không hỏi ứng dụng nào:

```sh
phone-app-checker report customers.csv --out report.csv
```

(`report` hiện câu trả lời gần nhất kể cả khi cũ hơn `maxAgeDays`; ô nào cũ hơn hạn **hoặc mang ngày ở tương lai** (đồng hồ máy sai) bị đánh dấu `<app>_stale` = `yes` và có dòng `STALE:` trong tóm tắt ("older than the max age or dated in the future") – đổi hạn bằng `--max-age <ngày>`. Nếu không có số hợp lệ nào, `report` vẫn ghi file (chỉ có các dòng `invalid`), in `WARNING: no valid phone numbers` và thoát mã `1`.)

Xem tài khoản và hạn mức đã dùng hôm nay:

```sh
phone-app-checker accounts
```

Sau khi bạn đã sửa nguyên nhân (ví dụ cắm lại điện thoại, ghép đôi lại), xóa trạng thái nghỉ/khóa của một tài khoản:

```sh
phone-app-checker account-reset telegram tg1
```

Danh sách đầy đủ lệnh và tùy chọn: `phone-app-checker --help` và `phone-app-checker <lệnh> --help`. Thông tin phiên bản (gửi kèm khi nhờ hỗ trợ): `phone-app-checker --version`.

`report.csv` và file đầu vào nằm trong **thư mục làm việc**, không nằm trong thư mục dữ liệu (mục 10).

## 9. Đọc kết quả trong báo cáo

Cột báo cáo: `input` (ô gốc bạn nhập), `e164` (số chuẩn quốc tế), `country`, `telegram`, `whatsapp`, `zalo`, `viber`, `line`, rồi:

- `last_checked_at`: thời điểm UTC **mới nhất** của *bất kỳ* kết quả đã lưu cho số này, kể cả một lần thử không ra kết quả. Nó **không** nói gì riêng về từng ứng dụng; trống với dòng `invalid`.
- `telegram_checked_at`, `whatsapp_checked_at`, `zalo_checked_at`, `viber_checked_at`, `line_checked_at`: thời điểm UTC của **chính câu trả lời `yes`/`not_found`** của ứng dụng đó; trống với `unknown`/`skipped`/`invalid`.
- `telegram_stale`, …, `line_stale`: `yes` nếu câu trả lời cũ hơn hạn (`--max-age`/`maxAgeDays`) hoặc mang ngày ở tương lai, `no` nếu còn mới, trống nếu ô không phải `yes`/`not_found`. Báo cáo cũ (không có 10 cột này) vẫn được ghi đè bình thường.

| Giá trị | Nghĩa |
| --- | --- |
| `yes` | Ứng dụng trả lời, **tại thời điểm `<app>_checked_at`**, rằng số này có tài khoản. Đó là một quan sát, không phải xác nhận người đó là ai, tài khoản còn hoạt động hay hiện giờ vẫn còn. |
| `not_found` | Ứng dụng **không trả về** tài khoản cho số này. **Không phải bằng chứng người đó không dùng ứng dụng**: người dùng có thể ẩn mình khỏi tìm kiếm bằng số điện thoại (Telegram, Zalo, LINE), và kết quả Viber phụ thuộc đồng bộ danh bạ. Nếu ứng dụng bị giới hạn ngầm, kết quả giả `not_found` có thể xuất hiện mà công cụ không phát hiện được. |
| `unknown` | Chưa kiểm tra, hoặc kiểm tra lỗi / bị giới hạn tốc độ, hoặc ứng dụng chưa có tài khoản đăng nhập. Chạy lại `check` – các số `unknown` được thử lại. |
| `skipped` | Ứng dụng đang tắt, không nằm trong `--apps`, hoặc số nằm ngoài phạm vi (Zalo chỉ kiểm tra `+84`). |
| `invalid` | Ô không phải số điện thoại hợp lệ (sau khi chuẩn hóa theo `defaultRegion`; số Excel đã thành dạng khoa học cũng vào đây). Ghi ở mọi cột ứng dụng. |

Nên hiểu: cả `yes` lẫn `not_found` chỉ là kết quả **một lần hỏi tại một thời điểm**; `not_found` còn có thể sai âm tính. Độ chính xác với tài khoản thật **chưa được đo** (mục 12).

### Khung INCOMPLETE

Cuối mỗi lần `check` (sau dòng `Report written to …`), nếu còn số chưa có câu trả lời `yes`/`not_found` **mới trong lần chạy này**, chương trình in:

```
========================================================================
INCOMPLETE: 6 of 6 checks have no fresh yes/not_found answer.
The report is NOT final: cells marked unknown are unchecked, and an older yes/not_found may be outdated.
  telegram: 2 inconclusive (0 attempted, 0 conclusive)
    - no_accounts: no usable telegram account (log in, or fix a disabled one: login telegram --account <name>)
Run the same command again to continue (finished numbers are not repeated).
========================================================================
```

Nghĩa: **báo cáo chưa hoàn chỉnh, đừng dùng làm kết quả cuối**. Lý do hay gặp (mỗi dòng `- <lý do>`): `no_accounts` (chưa đăng nhập/tài khoản bị tắt), tài khoản đang nghỉ hoặc hết hạn mức ngày (kèm dòng `Next resume: <giờ UTC>`), `adapter_error` (lỗi từ ứng dụng), `aborted` (bạn bấm Ctrl-C), lô bị tạm gạt sang một bên sau nhiều lần lỗi. Xử lý nguyên nhân rồi chạy lại **đúng lệnh cũ**. Chỉ khi không còn khung này (dòng tóm tắt mỗi ứng dụng kết thúc bằng `(all conclusive)` thay vì số còn lại) mới nói được lần chạy đã hỏi xong mọi số. Ngay cả khi đó vẫn xem `<app>_stale`. Khung này và dòng `STALE:` chỉ hiện trên màn hình, **không** nằm trong file CSV: copy chúng khi gửi báo cáo (mục 12).

## 10. Dữ liệu nằm ở đâu

| Đường dẫn | Nội dung | Tồn tại bao lâu |
| --- | --- | --- |
| `~/Applications/phone-app-checker/<phiên bản>/` | Chương trình (chỉ chép, không ghi dữ liệu vào đây) | Giữ lại các phiên bản cũ để quay lại |
| `~/Applications/phone-app-checker/current` | Liên kết tới phiên bản đang dùng | Đổi khi cài bản khác |
| `~/.local/bin/phone-app-checker` | Lệnh `phone-app-checker` | Xóa khi gỡ cài đặt |
| `~/.zprofile` hoặc `~/.bash_profile` | Đoạn PATH giữa hai dòng `# >>> phone-app-checker >>>` / `# <<< phone-app-checker <<<` (chỉ thêm khi cần) | Đoạn PATH bị xóa khi gỡ cài đặt; file trống do chính trình cài đặt tạo cũng bị xóa |
| `~/Library/Application Support/phone-app-checker/checker.config.json` | Cấu hình của bạn | **Còn lại** sau cập nhật và gỡ thường; chỉ xóa bằng `--purge-data` |
| `~/Library/Application Support/phone-app-checker/data/checker.db` | Mọi số đã kiểm tra, kết quả, thời gian, trạng thái tài khoản | Như trên |
| `~/Library/Application Support/phone-app-checker/data/sessions/<ứng dụng>/<tài khoản>/` | **Phiên đăng nhập** các tài khoản kiểm tra | Như trên |
| `~/Library/Application Support/phone-app-checker/data/check.lock` | Khóa "đang có lệnh chạy" | Tự xóa khi lệnh kết thúc |
| `~/Library/Application Support/phone-app-checker/data/check.lock.reclaim` | Chỉ tồn tại trong tích tắc lúc thu hồi một khóa cũ | Nếu còn sót → mục 14 ("Lock recovery was interrupted") |
| `~/Library/Application Support/phone-app-checker-lifecycle/` (**ngoài** thư mục dữ liệu và thư mục cài) | `shared/<pid>.…` cho mỗi lệnh đang chạy; `maintenance.lock` khi đang cài/gỡ | Tự dọn; nếu `maintenance.lock` còn sót → mục 14 |
| `~/Applications/phone-app-checker/.incoming.*`, `.replaced.*` | Bản đang chép / bản cũ giữ tạm trong lúc cài | Tự xóa khi cài xong; còn sót → chạy lại `install.sh` |
| Thư mục làm việc của bạn (ví dụ `~/phone-checks`) | File CSV đầu vào và `report.csv` | Do bạn quản lý; **không** đặt trong `Documents`/`Desktop`/thư mục đồng bộ |

Thư mục dữ liệu và `dataDir` phải là thư mục riêng, **không đồng bộ** và nằm **ngoài** `~/Applications/phone-app-checker`: dữ liệu khách hàng và phiên đăng nhập **không được nằm trong thư mục đồng bộ**. Chương trình từ chối (kể cả khi có file đánh dấu) khi `PHONE_APP_CHECKER_HOME` hoặc `dataDir` là `Documents`, `Desktop`, `Downloads`, `Library`, `Applications`, `Movies`, `Music`, `Pictures`, `Public`, `.local`, `.config`, `Library/Application Support`, `.local/bin`, thư mục home hay thư mục cha của nó, hoặc trùng/bao lấy thư mục cài đặt – hãy dùng một thư mục con riêng. Chương trình cũng từ chối **thư mục đồng bộ và mọi thư mục nằm bên trong nó**: iCloud Drive (`~/Library/Mobile Documents`, `~/iCloud Drive`), `~/Library/CloudStorage/*` (Dropbox, Google Drive, OneDrive, Box do macOS quản lý) và các thư mục `~/Dropbox*`, `~/Google Drive*` (`~/GoogleDrive*`), `~/OneDrive*`, `~/Box`, `~/Box Sync`, `~/Box Drive` (kể cả khi là symlink tới ổ khác). Ví dụ nên dùng: `~/phone-checks` hoặc để mặc định. Desktop và Documents có thể tự đồng bộ iCloud mà chương trình không phát hiện được; vì vậy đừng đặt dữ liệu ở đó.

Cơ sở dữ liệu `checker.db` hiện dùng **lược đồ phiên bản 2** (thêm bảng `failed_checks` ghi nhớ các số trong lô lỗi; tự nâng cấp từ bản 1 khi mở). Sau khi bản mới đã mở nó, **bản dựng cũ hơn không mở lại được** (`Database was written by a newer version`): đừng quay về bản dựng cũ trên cùng thư mục dữ liệu nếu chưa sao lưu `checker.db`.

Mở thư mục dữ liệu: `open ~/Library/Application\ Support/phone-app-checker`. Thư mục `Library` bị ẩn trong Finder; dùng lệnh trên hoặc Finder → *Go → Go to Folder…* → dán `~/Library/Application Support/phone-app-checker`.

## 11. Quyền riêng tư và an toàn

- Công cụ **không gửi tin nhắn, không gọi, không kết bạn/mời nhóm**, không đọc hay lưu tên, ảnh đại diện, user id, lần truy cập cuối hay hồ sơ người dùng. Nhật ký trên màn hình che số điện thoại (`+8490****567`). Số đầy đủ chỉ nằm trong cơ sở dữ liệu cục bộ và trong `report.csv` bạn yêu cầu. Ngoài các truy vấn mà chính ứng dụng nhắn tin thực hiện, không có gì được gửi tới bên thứ ba.
- **Thư mục `~/Library/Application Support/phone-app-checker` chứa phiên đăng nhập = toàn quyền truy cập các tài khoản kiểm tra**, cùng danh sách số đã kiểm tra (dữ liệu cá nhân của khách). Không gửi, không chép lên thư mục đồng bộ (iCloud Drive, Dropbox, Google Drive…), không đính kèm khi nhờ hỗ trợ, không đưa vào bản sao lưu bạn không kiểm soát. Thư mục được tạo với quyền chỉ riêng bạn đọc được; đừng đổi quyền. Gỡ cài đặt kèm xóa dữ liệu **không** đăng xuất từ xa các tài khoản và **không** phải xóa an toàn (bản sao lưu, snapshot Time Machine có thể còn dữ liệu).
- `report.csv` và file danh sách khách chứa số điện thoại thật. Lưu trong thư mục không đồng bộ, xóa khi không cần nữa. Khi cần gửi bản thử nghiệm cho người khác, chỉ dùng **số của nhân viên đã đồng ý** (mục 12).
- Dùng **SIM/tài khoản riêng, chấp nhận mất**. Mọi ứng dụng ở đây bị truy cập bằng phần mềm không chính thức; tài khoản có thể bị giới hạn hoặc khóa vĩnh viễn. Không dùng số cá nhân hay số đang phục vụ kinh doanh.
- Chỉ kiểm tra số của người đã đồng ý được liên hệ; chương trình không kiểm tra sự đồng ý. Trách nhiệm pháp lý và tuân thủ thuộc về người dùng.
- Giữ tốc độ mặc định (chậm) trước; tăng `batchSize`/`dailyCap` từng bước và theo dõi `phone-app-checker accounts`. Giới hạn thật của từng nền tảng **chưa được kiểm chứng**.
- Không chạy hai lệnh `check`/`login` cùng lúc: chương trình tự chặn bằng `check.lock` (kết nối WhatsApp thứ hai có thể làm tài khoản bị vô hiệu). Khóa tin vào một tiến trình trên **máy này**; thư mục dữ liệu phải nằm trên ổ cục bộ không đồng bộ (không iCloud, không ổ mạng). Việc bị buộc dừng giữa chừng không thể bảo đảm "không truy vấn lặp" hay "không sót danh bạ": xem mục 8.

## 12. Cách thử nghiệm đề xuất (A9) và gửi kết quả về

Mục tiêu: kiểm tra chương trình chạy đúng trên máy của bạn, và `yes`/`not_found` khớp thực tế. **Chưa có bản chạy thử trên tài khoản thật** (và chưa trên macOS 13.5) nên bước đối chiếu này là bắt buộc trước khi chạy dữ liệu khách hàng. Danh sách này là "A9" trong hồ sơ phát hành; chưa ai tích hoàn thành.

**Bước A – Nhận file, kiểm tra, cài đặt** (mục 2–5) bằng đúng kênh bạn sẽ dùng thật (AirDrop, tải về…) để dấu "tải từ Internet" được áp dụng. Ghi lại: Gatekeeper có chặn không và thông báo **nguyên văn** là gì ("unidentified developer" hay "is damaged" – hai trường hợp khác nhau, mục 14); Terminal có hỏi quyền truy cập thư mục không; máy có do công ty quản lý (MDM) không. Rồi lưu thông tin hỗ trợ vào thư mục làm việc:

```sh
mkdir -p ~/phone-checks && cd ~/phone-checks
phone-app-checker --version > support.txt 2>&1
phone-app-checker doctor >> support.txt 2>&1
sw_vers >> support.txt 2>&1
uname -m >> support.txt 2>&1
```

Nhắc lại: kết quả `doctor` chỉ nói về độ sẵn sàng offline.

**Bước B – Với từng ứng dụng muốn thử** (mục 6): đăng nhập thành công không? `phone-app-checker accounts` có hiện `ready` không? (Chỉ `login` thật mới chứng minh được tài khoản dùng được.)

**Bước C – File thử ~20 số của nhân viên đã đồng ý**, mỗi người bạn biết chắc có/không có từng ứng dụng (kể cả vài người đã bật quyền riêng tư "không cho tìm bằng số điện thoại" nếu có – ghi riêng nhóm này). Tạo `staff.csv` trong `~/phone-checks` (cột `phone`), rồi chạy **lô nhỏ, từng ứng dụng, có `--no-wait`, máy cắm điện**:

```sh
phone-app-checker check staff.csv --apps telegram --out staff-telegram.csv --no-wait
```

Đổi `telegram` thành `whatsapp`, `zalo`, `viber`, `line` tùy ứng dụng. Sau mỗi lần chạy hãy ghi lại:

- Có khung `INCOMPLETE` không? Nếu có thì lý do là gì (copy nguyên văn). Báo cáo có khung này **chưa tính là kết quả**: xử lý nguyên nhân rồi chạy lại cho tới khi hết.
- Người biết chắc **có** tài khoản → ra `yes` không? Người biết chắc **không có** → ra `not_found` không? Cột `<app>_stale` có là `no` không? (Người ẩn khỏi tìm kiếm có thể ra `not_found` dù có tài khoản – ghi riêng. Đừng tính một con số "chính xác chung": tách nhóm tìm thấy được / ẩn khỏi tìm kiếm / `unknown`.)
- Có dòng báo `DISABLED`, `cooling down`, `rate limit`, hoặc nhiều số `unknown` không? (`phone-app-checker accounts`.)
- Bấm **Ctrl-C một lần** giữa chừng, **đợi** nó ghi báo cáo xong, rồi chạy lại: các số đã có kết quả không bị hỏi lại? (Đừng thử buộc thoát trên dữ liệu quan trọng.)
- Telegram: danh bạ của tài khoản kiểm tra có trống sau khi chạy không? Viber: trên máy Android có còn danh bạ tên `phone-app-checker` không?
- Thời gian chạy lô bao lâu; mức nghỉ có hợp lý không.

**Bước D – Cập nhật/quay lại/gỡ** (mục 13) trên chính máy đó: không còn dấu vết sau khi gỡ? (Thử `--purge-data` chỉ sau khi đã chép đi những gì cần.)

**Bước E – Gửi về những gì**:

| Gửi | Không gửi |
| --- | --- |
| `~/phone-checks/support.txt` (phiên bản, `doctor`, macOS, chip) | **Thư mục `Application Support/phone-app-checker`** (phiên đăng nhập!) |
| **Nguyên văn** khung `INCOMPLETE`/dòng `STALE:`/thông báo lỗi trong Terminal (Cmd + A, Cmd + C; số điện thoại trong nhật ký đã được che) | `checker.config.json` còn `apiHash` (xóa/che hai giá trị `apiId`/`apiHash` trước khi gửi) |
| Kết quả `phone-app-checker accounts` | Ảnh QR, mã OTP, mật khẩu, mã ghép đôi |
| `staff-*.csv` **chỉ khi** là số nhân viên đã đồng ý và gửi qua kênh an toàn; **hoặc** bản đã che số: mở bằng Excel/Numbers, xóa hai cột `input` và `e164`, lưu thành file **mới** (đừng sửa file gốc) – vẫn đủ để so `country`, kết quả, `*_checked_at`, `*_stale`. Kèm bảng "đáp án đúng" bạn tự ghi | Bất kỳ file chứa số điện thoại **của khách hàng** |
| Ghi chú: ứng dụng nào, tài khoản nào thử, điều gì xảy ra, ảnh chụp màn hình thông báo lỗi (che số điện thoại) | |

Nếu có thể, nói rõ: chip máy (About This Mac), **phiên bản macOS** (đặc biệt nếu là 13.x/14.x), máy có do công ty quản lý (MDM) không, và kênh bạn nhận file (AirDrop, USB, chia sẻ nội bộ…).

**Mở báo cáo trong Excel:** `report.csv` là CSV dấu phẩy, UTF-8, không có BOM. Đừng bấm đúp (Excel Windows có thể hiển thị sai tiếng Việt ở cột `input`); dùng *Data → From Text/CSV*, chọn **UTF-8**, dấu phân cách **Comma**, và đặt các cột `input`, `e164` ở dạng **Text** để Excel không đổi số.

## 13. Cập nhật, quay lại bản cũ, gỡ cài đặt

**Cập nhật:** nhận file mới (làm lại mục 2–3 cho phiên bản mới, tên thư mục có số phiên bản mới), rồi:

```sh
bash ~/Downloads/phone-app-checker-<phiên bản mới>-macos-arm64/install.sh
```

Chương trình mới được chép vào thư mục riêng, `current` đổi sang bản mới. **Cấu hình, phiên đăng nhập và kết quả giữ nguyên.** Bản cũ được giữ lại; trình cài đặt in lệnh `rm -rf` để xóa nếu bạn muốn. Lưu ý lược đồ cơ sở dữ liệu (mục 10): bản mới có thể nâng cấp `checker.db` và bản cũ hơn rồi không mở lại được.

**Quay lại bản cũ** (ví dụ `0.1.0`):

```sh
bash ~/Applications/phone-app-checker/0.1.0/install.sh
```

Chỉ đổi lại liên kết `current`, dữ liệu không đổi (xem lưu ý lược đồ ở mục 10 trước khi quay về một bản dựng cũ hơn).

**Gỡ cài đặt** (xóa chương trình, lệnh, đoạn PATH; **giữ lại** cấu hình, phiên đăng nhập, kết quả):

```sh
bash ~/Applications/phone-app-checker/current/uninstall.sh
```

**Gỡ và xóa luôn dữ liệu** (không thể khôi phục – mất toàn bộ phiên đăng nhập, kết quả đã lưu, cấu hình):

```sh
bash ~/Applications/phone-app-checker/current/uninstall.sh --purge-data
```

Chương trình hỏi lại; gõ đúng `DELETE` (chữ hoa) để xác nhận. **Nếu gõ sai hoặc để trống, chương trình vẫn được gỡ** (lệnh, đoạn PATH, thư mục cài đặt) và chỉ dữ liệu được giữ lại; lúc đó lệnh `~/Applications/phone-app-checker/current/uninstall.sh` ở trên **không còn nữa**. Muốn xóa dữ liệu sau này, chạy `uninstall.sh` **trong gói đã tải/giải nén** (ví dụ `bash ~/Downloads/phone-app-checker-0.1.0-macos-arm64/uninstall.sh --purge-data`); nó vẫn đọc `dataDir` trong `checker.config.json` **trước** khi xóa và báo thư mục `dataDir` nằm ngoài (sẽ **không** bị xóa). Nếu không xác định chắc chắn được `dataDir`, nó từ chối xóa dữ liệu và giữ nguyên cấu hình – xem `dataDir` trong file đó và tự xóa thư mục ấy. Trước khi xóa nên đăng xuất các thiết bị đã liên kết trên điện thoại (WhatsApp → Thiết bị đã liên kết; Zalo/LINE tương tự) nếu không dùng lại các tài khoản đó: xóa dữ liệu **chỉ xóa file trên máy này, không đăng xuất từ xa, và không phải xóa an toàn** (bản sao lưu/Time Machine có thể còn bản sao). File CSV và `report.csv` trong thư mục làm việc **không bị đụng tới** – tự xóa nếu không cần.

Khi chương trình đã gỡ, `uninstall.sh` đọc `checker.config.json` bằng **trình phân tích JSON thật** (Node đi kèm trong gói, hoặc `osascript` có sẵn của macOS) – giống hệt cách chương trình đọc, nên khóa viết kiểu `"\u0064ataDir"` vẫn được nhận ra. Nó **không bao giờ** suy ra "không có `dataDir`" từ việc tìm chuỗi văn bản. Nếu không có trình phân tích nào, không đọc được file hoặc file không phải JSON hợp lệ, `--purge-data` từ chối (chưa xóa gì, giữ nguyên cấu hình); gỡ cài đặt không kèm `--purge-data` vẫn chạy và ghi chú rằng `dataDir` không đọc được chắc chắn.

Cài, cài lại và gỡ cài đặt đều **từ chối** khi còn bất kỳ lệnh `phone-app-checker` nào đang chạy (kể cả `report`, `accounts`, `doctor`) sau ~3 giây chờ. Riêng file `check.lock` (mục 14) chỉ làm **cài lại cùng phiên bản** và **gỡ cài đặt** bị từ chối; cài sang một phiên bản **khác** không xét `check.lock` (các lệnh của bản 0.1.0 trở lên vẫn được bảo vệ bằng việc đăng ký lệnh đang chạy ở trên). Gỡ cài đặt cũng từ chối (chưa xóa gì) nếu thư mục dữ liệu hay `dataDir` nằm **bên trong** `~/Applications/phone-app-checker` (sẽ bị xóa theo).

`--purge-data` chỉ xóa nguyên một thư mục khi nó đúng là thư mục **riêng tên `phone-app-checker`** (mặc định `~/Library/Application Support/phone-app-checker`) và chứa `checker.config.json` hoặc `data/checker.db` thật (không phải symlink). Nó **từ chối** – kể cả khi có `--yes` và dù có file đánh dấu – nếu đường dẫn là: thư mục home hay thư mục cha của nó, symlink, không thuộc về bạn, thư mục riêng của bạn (`Documents`, `Desktop`, `Downloads`, `Library`, …), trùng/bao lấy thư mục cài đặt, hoặc một thư mục tùy chọn không tên `phone-app-checker`. Khi bị từ chối không có gì bị xóa: hãy tự xóa những gì bạn đã tạo trong đó (`checker.config.json`, thư mục `data`). Nếu `dataDir` trong cấu hình là đường dẫn tuyệt đối **ngoài** thư mục đó thì nó **không bị xóa**; lệnh in rõ đường dẫn còn lại để bạn tự xử lý.

`--purge-data` cũng từ chối chính thư mục đồng bộ (`~/Library/Mobile Documents`, `~/Library/CloudStorage` và từng thư mục con của nó, `~/Dropbox*`, `~/Google Drive*`, `~/OneDrive*`, `~/Box`, `~/Box Sync`, `~/Box Drive`, `~/iCloud Drive`) để không bao giờ xóa cả kho đồng bộ của bạn. Nếu bạn từng đặt thư mục dữ liệu riêng tên `phone-app-checker` (có file đánh dấu) *bên trong* một thư mục đồng bộ từ bản cũ, chỉ thư mục riêng đó được xóa; hãy chuyển dữ liệu ra ổ cục bộ sau đó.

## 14. Sự cố thường gặp

**`command not found: phone-app-checker`**
Mở **cửa sổ Terminal mới** sau khi cài. Vẫn không được:

```sh
export PATH="$HOME/.local/bin:$PATH"
phone-app-checker --version
```

Nếu chạy được thì PATH chưa được ghi vĩnh viễn (ví dụ shell của bạn không phải zsh/bash); trình cài đặt đã in dòng cần thêm vào file khởi động shell. Hoặc chạy bằng đường dẫn đầy đủ: `~/Applications/phone-app-checker/current/phone-app-checker --version`.

**macOS báo "cannot be opened because the developer cannot be verified" / "Apple cannot check it for malicious software" (nhà phát triển chưa được xác định)**
macOS đánh dấu file tải từ Internet. Trình cài đặt đã gỡ dấu này khỏi bản đã cài; nếu vẫn bị chặn và file **đã qua bước kiểm tra checksum ở mục 2**, chạy:

```sh
xattr -dr com.apple.quarantine ~/Applications/phone-app-checker
xattr -dr com.apple.quarantine ~/Downloads/phone-app-checker-0.1.0-macos-arm64
```

Nếu vẫn bị chặn: *System Settings → Privacy & Security* → kéo xuống phần thông báo về `node` hoặc `phone-app-checker` → **Open Anyway**, rồi chạy lại. Nếu Mac do công ty quản lý (MDM) có thể chặn chương trình chưa được ký/duyệt: báo người quản trị IT hoặc người gửi bản này, kèm nội dung thông báo.

**macOS báo "is damaged and can't be opened" / "will damage your computer" – DỪNG, đây là trường hợp khác**
Đừng chạy `xattr` và đừng bấm **Open Anyway**. Thông báo này nghĩa là file có thể hỏng hoặc bị sửa: xóa thư mục giải nén, nhận lại file từ người gửi, lặp lại mục 2 (`shasum -c` phải ra `OK`), và nếu vẫn lỗi thì báo người gửi kèm nguyên văn thông báo. **Không bao giờ** tắt SIP hay tắt Gatekeeper toàn máy (`spctl --master-disable`) để chạy bản này – không cần thiết và làm Mac kém an toàn.

**Thông báo về Rosetta / máy Intel / "not an Apple Silicon Mac"**
Bản này chỉ chạy trên chip Apple Silicon, trong Terminal **chạy native**. Nếu máy là M1/M2/M3… nhưng báo đang chạy qua Rosetta: Finder → *Applications → Utilities → Terminal* → bấm chuột phải → *Get Info* → bỏ chọn **Open using Rosetta** → mở lại Terminal. Kiểm tra: `uname -m` phải in `arm64`. Nếu in `x86_64` trên máy Apple Silicon, vẫn đang ở Rosetta. Mac Intel thật sự không hỗ trợ bản này.

**"macOS quá cũ" / báo cần 13.5**
Cần macOS 13.5 trở lên. Cập nhật tại *System Settings → General → Software Update*. Không cập nhật được → không chạy được bản này (báo người gửi).

**`Operation not permitted` / "Permission denied" khi đọc file trong *Downloads*, *Documents* hoặc *Desktop* (hoặc cửa sổ hỏi quyền bị lỡ bấm Don't Allow)**
macOS chặn ứng dụng Terminal đọc các thư mục này cho tới khi bạn cho phép. Mở *System Settings → Privacy & Security → Files & Folders*, tìm **đúng ứng dụng Terminal bạn đang dùng** (Terminal, iTerm, …) và bật thư mục cần dùng, rồi mở cửa sổ Terminal mới. Cách sạch hơn: chép file vào `~/phone-checks` (mục 7) rồi chạy ở đó. **Không** cần *Full Disk Access* và **không** dùng `sudo`.

**`check.lock` / "Another check or login is already running" / cài đặt hoặc gỡ từ chối vì đang có lệnh chạy**
Chỉ cho phép một lệnh `check`/`login`/`account-reset` tại một thời điểm (tránh dùng một tài khoản hai lần). Thông báo của chương trình: `Another check or login is already running (pid …, lock …). Wait for it to finish; if nothing is running, delete <đường dẫn file khóa> (the pid may have been reused after a crash or power cut).` Sau khi khởi động lại máy, số pid trong file khóa có thể đã được tiến trình khác dùng lại nên trông như "vẫn đang chạy": kiểm tra bằng `ps aux | grep phone-app-checker` rồi xóa đúng file được nêu. Đợi lệnh kia xong hoặc đóng cửa sổ Terminal đang chạy nó (Ctrl-C trước). Khi chạy lại `check`/`login`, một khóa do tiến trình đã chết để lại (hoặc file khóa hỏng) được tự thu hồi. **Trình cài đặt và gỡ cài đặt thì không tự thu hồi** – chúng chỉ kiểm tra file có tồn tại (`Đang có lệnh chạy … check.lock`). Nếu **chắc chắn** không còn lệnh nào chạy (kiểm tra `ps aux | grep phone-app-checker`) mà vẫn bị chặn, xóa file:

```sh
rm ~/Library/Application\ Support/phone-app-checker/data/check.lock
```

Trình cài đặt/gỡ tìm file khóa ở đúng thư mục dữ liệu mà chương trình đang dùng: thư mục `dataDir` trong `checker.config.json` (mặc định `data/`; có thể là `./store` hay đường dẫn tuyệt đối) và mọi file `check.lock` nằm ngay trong thư mục dữ liệu của chương trình. Thông báo từ chối luôn ghi rõ đường dẫn file khóa cần xóa.

**`Lock recovery was interrupted: … was left by a process that is no longer running … Repair: … delete …check.lock.reclaim`**
Một lệnh bị buộc dừng đúng lúc đang dọn khóa cũ. Chương trình **cố ý không tự sửa** (sửa sai có thể để hai lệnh cùng dùng một tài khoản). Làm theo thứ tự: (1) đóng mọi cửa sổ Terminal đang chạy phone-app-checker và kiểm tra `ps aux | grep phone-app-checker` không còn tiến trình nào; (2) xóa **đúng file mà thông báo nêu** (thường `~/Library/Application Support/phone-app-checker/data/check.lock.reclaim`); (3) chạy lại lệnh – khóa `check.lock` cũ sẽ được thu hồi như bình thường. Thông báo `Could not acquire the run lock …` nói thêm tên file `check.lock.reclaim`: có tiến trình khác đang dọn khóa – đợi vài giây rồi chạy lại; nếu ở lần chạy lại vẫn bị chặn và `ps` không thấy lệnh nào đang chạy, xóa đúng file `check.lock.reclaim` nêu trong thông báo.

**`An earlier install or uninstall of phone-app-checker was interrupted: …maintenance.lock was left by …`** (mọi lệnh đều từ chối, không mở gì)
Lần cài/gỡ trước bị ngắt khi đang giữ khóa bảo trì. Chắc chắn không còn `install.sh`/`uninstall.sh` hay lệnh phone-app-checker nào đang chạy, xóa file `maintenance.lock` được nêu (trong `~/Library/Application Support/phone-app-checker-lifecycle/`), rồi chạy lại `install.sh` của gói đã tải để chắc chắn bản cài còn nguyên. **`An install or uninstall … is in progress (pid …, <file>)`** / **`a phone-app-checker command is running (pid …, file <file>)`**: bên kia có vẻ còn sống – đợi nó xong hoặc đóng cửa sổ Terminal tương ứng, rồi làm lại. Nhưng sau mất điện/khởi động lại, pid trong file có thể đã bị tiến trình khác dùng lại: nếu `ps aux | grep -E 'phone-app-checker|install.sh|uninstall.sh'` cho thấy **không** có gì đang chạy, xóa đúng file mà thông báo ghi (`If nothing is running, delete <file>`). Chương trình không bao giờ tự xóa các file này.

**`… is your Documents folder (hoặc Desktop, …), which holds your own files; refusing to use it …` / `… is, or lies inside, the synced folder …` / `… overlaps the installation folder …`**
`PHONE_APP_CHECKER_HOME` hoặc `dataDir` đang trỏ vào thư mục riêng của bạn, vào thư mục đồng bộ (iCloud Drive, `~/Library/CloudStorage/*`, Dropbox, Google Drive, OneDrive, Box) hoặc vào/bao lấy `~/Applications/phone-app-checker`. Đừng cố vượt qua: dữ liệu khách hàng và phiên đăng nhập không được nằm trong thư mục đồng bộ. Dùng một thư mục con riêng ngoài các nơi đó (thông báo gợi ý tên), hoặc bỏ cấu hình tùy chỉnh để dùng mặc định.

**`Database was written by a newer version (schema 2, supported 1)`**
Bạn đang chạy một bản dựng cũ hơn trên dữ liệu đã được bản mới nâng cấp (mục 10). Cài lại bản mới. Chỉ khi chấp nhận mất kết quả đã lưu mới đổi tên `checker.db` (và `-wal`/`-shm`) để bản cũ tạo lại.

**`no valid phone numbers (N invalid)` / `Cannot find a phone column` / `Cannot tell how the columns are separated`**
Chương trình dừng trước khi hỏi bất kỳ ứng dụng nào. Mở file CSV, kiểm tra cột số điện thoại, dùng `--column phone` hoặc `--column 2`, lưu lại *CSV UTF-8 (Comma delimited)* (mục 7) – chú ý Excel có thể đã đổi số thành dạng khoa học. Thông báo cố ý không in số điện thoại trong file.

**`INCOMPLETE`**
Không phải lỗi mà là cảnh báo kết quả chưa đủ: xem "Khung INCOMPLETE" ở mục 9.

**Bị giới hạn tốc độ (throttling) – `cooling down until …`, `rate limit`, `FLOOD_WAIT`, nhiều số `unknown`**
Ứng dụng đã bảo chương trình chậm lại; tài khoản tạm nghỉ vài giờ đến 24 giờ (Telegram/WhatsApp 6 giờ, Zalo/LINE 24 giờ, Viber 12 giờ nếu ứng dụng không nói rõ). Đây là cơ chế bảo vệ, không phải lỗi. Xem trạng thái bằng `phone-app-checker accounts`. Cách xử lý: chờ rồi chạy lại `check` (số `unknown` được thử lại); dùng thêm tài khoản; giảm `batchSize`/`dailyCap`/tăng `minIntervalMs` trong file cấu hình; không dùng tài khoản mới tinh. Nếu thấy `DISABLED` (ví dụ `PEER_FLOOD`, WhatsApp bị gỡ liên kết): cần người xử lý – kiểm tra điện thoại/tài khoản, rồi `login <ứng dụng> --account <tên>` lại hoặc `phone-app-checker account-reset <ứng dụng> <tên>` sau khi đã xử lý nguyên nhân. Danh sách lớn có thể chạy nhiều ngày; xem `caffeinate` và `--no-wait` ở mục 8.

**`adb not found` / "no Android device ready" (chỉ Viber)**
Cài Android platform-tools (cung cấp `adb`), bảo đảm `adb version` chạy được; hoặc điền `apps.viber.options.adbPath`. Cắm máy Android/mở máy ảo, `adb devices` phải liệt kê máy ở trạng thái `device`. Chi tiết: `~/Applications/phone-app-checker/current/app/docs/viber-setup.md`. Nếu không dùng Viber, để `"enabled": false`.

**`doctor` báo `FAIL config`**
File `checker.config.json` sai cú pháp JSON hoặc có khóa lạ/giá trị không hợp lệ. Dòng lỗi nói rõ chỗ sai; sửa rồi chạy lại, hoặc đổi tên file để tạo lại bản mẫu (mục 5).

**`doctor` báo `FAIL data`**
Thư mục dữ liệu bị lỗi quyền, bị thay bằng liên kết tắt (symlink) hoặc thuộc người dùng khác. Không đổi thủ công; gửi nội dung dòng lỗi cho người hỗ trợ (mục 12).

**Hỏi hỗ trợ cần gì:** kết quả `phone-app-checker --version` và `phone-app-checker doctor`, chip và phiên bản macOS, nguyên văn khung `INCOMPLETE` và thông báo lỗi (mục 12, bước E).
