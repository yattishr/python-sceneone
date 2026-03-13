FROM node:20-bookworm-slim AS deps

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:20-bookworm-slim AS builder

WORKDIR /app
ARG NEXT_PUBLIC_BACKEND_URL
ARG NEXT_PUBLIC_ADK_LIVE_APP_NAME=scene_one_agent
ARG NEXT_PUBLIC_ADK_LIVE_USER_ID=studio_user_01
ARG NEXT_PUBLIC_ADK_LIVE_MODALITY=AUDIO
ARG COPILOTKIT_AGENT_URL

ENV NEXT_PUBLIC_BACKEND_URL=${NEXT_PUBLIC_BACKEND_URL} \
    NEXT_PUBLIC_ADK_LIVE_APP_NAME=${NEXT_PUBLIC_ADK_LIVE_APP_NAME} \
    NEXT_PUBLIC_ADK_LIVE_USER_ID=${NEXT_PUBLIC_ADK_LIVE_USER_ID} \
    NEXT_PUBLIC_ADK_LIVE_MODALITY=${NEXT_PUBLIC_ADK_LIVE_MODALITY} \
    COPILOTKIT_AGENT_URL=${COPILOTKIT_AGENT_URL}

COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080

COPY --from=builder /app ./

EXPOSE 8080

CMD ["sh", "-c", "npm run start -- --hostname 0.0.0.0 --port ${PORT}"]
