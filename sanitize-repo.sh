#!/bin/bash
# Sanitize jarvis-voice repository for public release
set -e

echo "🧹 Sanitizing jarvis-voice repository..."

# Remove internal planning docs (too much internal context)
echo "📝 Removing internal planning docs..."
rm -f PLAN-CHANNEL-MOBILITY.md
rm -f IMPLEMENTATION-SUMMARY.md
rm -f IMPLEMENTATION_COMPLETE.md
rm -f COMPLETION_SUMMARY.md

# Replace /home/generic/ with $HOME/ or ~/ in all markdown files
echo "🔧 Fixing file paths..."
find . -name "*.md" -type f -not -path "./node_modules/*" -exec sed -i 's|/home/generic/dev/jarvis-voice|./jarvis-voice|g' {} \;
find . -name "*.md" -type f -not -path "./node_modules/*" -exec sed -i 's|/home/generic/|~/|g' {} \;

# Replace Lance with generic terms in docs
echo "👤 Genericizing personal references..."
find . -name "*.md" -type f -not -path "./node_modules/*" -exec sed -i 's/Lance joined/User joined/g' {} \;
find . -name "*.md" -type f -not -path "./node_modules/*" -exec sed -i 's/Lance admin/User admin/g' {} \;
find . -name "*.md" -type f -not -path "./node_modules/*" -exec sed -i 's/lance-dm/user-dm/g' {} \;
find . -name "*.md" -type f -not -path "./node_modules/*" -exec sed -i 's/lance-/user-/g' {} \;
find . -name "*.md" -type f -not -path "./node_modules/*" -exec sed -i 's/Lance/the user/g' {} \;

# Remove internal project names
echo "🏢 Removing internal project references..."
find . -name "*.md" -type f -not -path "./node_modules/*" -exec sed -i 's/ewitness/project-alpha/gi' {} \;
find . -name "*.md" -type f -not -path "./node_modules/*" -exec sed -i 's/eWitness/Project Alpha/g' {} \;
find . -name "*.md" -type f -not -path "./node_modules/*" -exec sed -i 's/gibson/project-beta/gi' {} \;
find . -name "*.md" -type f -not -path "./node_modules/*" -exec sed -i 's/redline/project-gamma/gi' {} \;
find . -name "*.md" -type f -not -path "./node_modules/*" -exec sed -i 's/block-equity/project-delta/gi' {} \;
find . -name "*.md" -type f -not -path "./node_modules/*" -exec sed -i 's/forensics-case-1/project-epsilon/g' {} \;

# Remove Unit 221B references
echo "🏢 Removing organization references..."
find . -name "*.md" -type f -not -path "./node_modules/*" -exec sed -i 's/Unit221B/YourOrg/gi' {} \;
find . -name "*.md" -type f -not -path "./node_modules/*" -exec sed -i 's/Unit 221B/YourOrg/gi' {} \;

# Replace Discord channel IDs with placeholders
echo "💬 Sanitizing Discord channel IDs..."
find . -name "*.md" -type f -not -path "./node_modules/*" -exec sed -i 's/1469077140862668802/YOUR_CHANNEL_ID/g' {} \;
find . -name "*.md" -type f -not -path "./node_modules/*" -exec sed -i 's/1469077140862668803/YOUR_CHANNEL_ID/g' {} \;
find . -name "*.md" -type f -not -path "./node_modules/*" -exec sed -i 's/1469140782077313180/YOUR_CHANNEL_ID/g' {} \;
find . -name "*.md" -type f -not -path "./node_modules/*" -exec sed -i 's/1469229827633451100/YOUR_CHANNEL_ID/g' {} \;
find . -name "*.md" -type f -not -path "./node_modules/*" -exec sed -i 's/1469230147663298610/YOUR_CHANNEL_ID/g' {} \;

# Replace example names
echo "📧 Fixing example names..."
find . -name "*.md" -type f -not -path "./node_modules/*" -exec sed -i 's/Sarah Chen/Jane Doe/g' {} \;
find . -name "*.md" -type f -not -path "./node_modules/*" -exec sed -i 's/Allison/Project Manager/g' {} \;

# Update .env.example to emphasize SESSION_USER and DISCORD_CHANNEL_ID
echo "⚙️  Updating .env.example..."
cat >> .env.example << 'EOF'

# User Configuration
SESSION_USER=jarvis-voice-user
DISCORD_CHANNEL_ID=your_discord_channel_id
EOF

echo "✅ Sanitization complete!"
echo ""
echo "Next steps:"
echo "1. Review changes with: git diff"
echo "2. Check for any remaining sensitive data"
echo "3. Consider squashing git history to remove pre-sanitization commits"
echo "4. Update LICENSE year if needed"
