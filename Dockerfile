FROM node:20-alpine
WORKDIR /app
COPY package.json server.js index.html questions.json ./
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server.js"]
