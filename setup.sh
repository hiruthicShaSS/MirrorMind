#!/bin/bash
# Quick dev setup

echo "🚀 Setting up Mirror Mind..."

# Install dependencies
echo "📦 Installing dependencies..."
npm install

# Create .env if not exists
if [ ! -f .env ]; then
  echo "⚙️  Creating .env from template..."
  cp .env.example .env
  echo "⚠️  Update .env with your Firebase service account key path"
fi

# Check for Firebase key
if [ ! -f ./firebase-key.json ]; then
  echo "⚠️  Firebase service account key not found!"
  echo "📋 Follow the steps in FIREBASE_SETUP.md to get your key"
  echo ""
fi

echo "✅ Setup complete!"
echo ""
echo "🎯 Next steps:"
echo "  1. Get Firebase service account key (see FIREBASE_SETUP.md)"
echo "  2. Place it as ./firebase-key.json"
echo "  3. Update .env with GOOGLE_API_KEY"
echo "  4. Run: npm run dev"
echo "  5. Open: http://localhost:5000"
echo ""
