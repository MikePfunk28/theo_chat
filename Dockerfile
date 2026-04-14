FROM node:18-alpine

WORKDIR /app

# Copy only the service directory
COPY service/package*.json ./
RUN npm ci --production

COPY service/ ./

EXPOSE 9300

CMD ["node", "index.js"]
