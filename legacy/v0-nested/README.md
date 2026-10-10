# MuxMind AI (v1.0 Enterprise Edition)

محرك تنسيق ذكاء اصطناعي متعدد المزودين (Anthropic Claude, Google Gemini, Groq, OpenRouter, Mistral, DeepSeek).

## التشغيل

```bash
npm install
cp .env.example .env   # اختياري: أضف مفاتيحك هنا أو من واجهة "🔑 المفاتيح"
npm start
```

ثم افتح: `http://localhost:3000`

## المميزات
- **توجيه ذكي (Auto Routing):** يصنف كل رسالة إلى Tier 1 (سريع) / Tier 2 (متوازن) / Tier 3 (استدلال عميق) ويختار أفضل مزود تلقائيًا.
- **سلسلة احتياط لا نهائية:** عند فشل مزود (429/5xx) ينتقل تلقائيًا للتالي بدون مقاطعة الجلسة.
- **زر "🌐 المزودون":** يعرض لكل مزود رابط صفحة الحصول على مفتاح API، توثيق الـ API، وصفحة الأسعار (نماذج مجانية وغير مجانية).
- **زر "🔑 المفاتيح":** إدخال المفتاح، التحقق منه (Validate)، واكتشاف النماذج المتاحة ديناميكيًا.
- **دعم صوتي ثنائي اللغة:** عربي/إنجليزي عبر Web Speech API.
- **رفع ملفات متعدد الصيغ:** PDF, JS, CSS, HTML, PY, TXT, صور.
- **خادم عنقودي (Cluster):** يستغل كل أنوية المعالج للتزامن العالي.

## بنية المشروع
```
muxmind-ai/
├── package.json
├── server.js
├── index.html
├── style.css
└── src/
    ├── config.js
    ├── api-manager.js
    ├── router.js
    ├── tts-engine.js
    ├── file-parser.js
    └── ui-render.js
```
