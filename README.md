# Jagruk Mahila RAG service

This is an optional, standalone retrieval-augmented generation (RAG) chat backend for the existing Expo app. It indexes the English, Hindi and Urdu content in `../constants/`, retrieves relevant passages with a small local TF-IDF index, then asks Groq's OpenAI-compatible chat API to answer using only those passages. No vector database or paid embedding API is required. The index is rebuilt at startup from the project files.

The current Express backend and app already exchange `POST /chat` requests shaped as `{ "question": "..." }` and expect `{ "answer": "..." }`. This service uses that same contract; it can be deployed on its own or used as the app's chat backend.

## Run locally

Requirements: Node.js 20 or newer and a Groq API key. Create a key in the Groq console. If a real key was pasted into chat, revoke it and create a replacement before use.

```sh
cd rag
npm install
cp .env.example .env
```

Put the replacement key in `rag/.env` as `GROQ_API_KEY=...`. Never use an `EXPO_PUBLIC_` variable for a provider key. Then:

```sh
npm start
```

Check `http://localhost:3001/health`; send a request to `POST http://localhost:3001/chat` with JSON `{"question":"What can I do if I am in immediate danger?"}`.

## Deploy

Render or Railway can host this as a Node web service:

- Root directory: `rag`
- Build command: `npm install`
- Start command: `npm start`
- Environment variables: `GROQ_API_KEY` (secret), optionally `GROQ_MODEL`, `PORT`, and `ALLOWED_ORIGINS`

The data files are read from the repository's `constants/` directory, so deploy the repository with the `rag/` folder and its sibling `constants/` directory included. After deploying, confirm `https://YOUR-SERVICE/health` returns `{"status":"ok"}`.

## Connect the existing app

The app uses `EXPO_PUBLIC_CHAT_API_BASE_URL` for chat and `EXPO_PUBLIC_API_BASE_URL` for reports. The former can point directly to this service; keep the latter set to the existing backend so report submissions continue working:

```sh
EXPO_PUBLIC_CHAT_API_BASE_URL=https://YOUR-RAG-SERVICE \
EXPO_PUBLIC_API_BASE_URL=https://jagruk-mahila.onrender.com \
npx expo start
```

For an EAS build, set `EXPO_PUBLIC_CHAT_API_BASE_URL` in the build environment (and retain the report backend URL). Expo public variables contain URLs only; the Groq key belongs only in the server's secret environment. You can also route `/chat` through the existing Express backend by setting its `CHAT_URL` to `https://YOUR-RAG-SERVICE/chat`.

## Notes

- Retrieval uses token overlap and TF-IDF, which is lightweight and suitable as a simple starter, but less semantically capable than embedding-based retrieval.
- The answer includes retrieved source titles. Treat output as legal awareness information, not personalized legal advice; verify important details against current authoritative law and consult a qualified professional.
- The bundled app data is the knowledge base. Add or update content in `constants/` and restart/redeploy this service to rebuild its index.
