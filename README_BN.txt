SPL USER PANEL — UPDATED FILE

মূল ফাইল: index.html
এই আপডেটে:
- Withdrawal request status canonical pending রাখা হয়েছে।
- Registration page bonus label site_settings/registration_bonus থেকে live update হয়।
- Withdrawal history status mapping: pending=অপেক্ষমাণ, success=সম্পন্ন, failed=ব্যর্থ।

গুরুত্বপূর্ণ:
- User Panel Firebase Realtime Database-এর users/{phone}/withdrawals এবং withdrawal_requests path ব্যবহার করে।
- Admin Panel-এর সাথে একই Firebase project ব্যবহার করতে হবে।
- Database Rules-এ signed-in user-এর নিজের record write এবং admin-এর withdrawal_requests review access সঠিকভাবে অনুমোদিত থাকতে হবে।
- এই প্যাকেজে কোনো Firebase secret বা service-account key নেই।
