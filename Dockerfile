FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev --ignore-scripts
COPY server ./server
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server/index.js"]
