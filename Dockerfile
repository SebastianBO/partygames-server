FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm ci --only=production

COPY . .

# WebSocket port
EXPOSE 8080
# Health check port
EXPOSE 3000

CMD ["node", "server.js"]
