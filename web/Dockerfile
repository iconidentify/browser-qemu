FROM node:22-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .

# Build-time base path for reverse-proxied installs, e.g. /my/prefix/
ARG VITE_BASE_URL=/
ENV VITE_BASE_URL=$VITE_BASE_URL

# Optional build-time override for relay websocket URL (normally same-origin /ethernet).
ARG VITE_RELAY_URL=
ENV VITE_RELAY_URL=$VITE_RELAY_URL

RUN npm run build

FROM nginx:1.27-alpine

COPY ./deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
