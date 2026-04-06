import React from 'react'
import { Box, Text } from '../../ink.js'
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import {
  companionUserId,
  getCompanion,
  roll,
} from '../../buddy/companion.js'
import { isBuddyLive } from '../../buddy/useBuddyNotification.js'
import {
  RARITY_COLORS,
  RARITY_STARS,
  STAT_NAMES,
  type CompanionBones,
  type CompanionSoul,
  type StoredCompanion,
} from '../../buddy/types.js'
import { renderSprite } from '../../buddy/sprites.js'
import type { LocalJSXCommandCall } from '../../types/command.js'
import { useTheme } from '../../ink.js'

// Fallback names when soul generation API is unavailable
const FALLBACK_NAMES = [
  'Crumpet',
  'Soup',
  'Pickle',
  'Biscuit',
  'Moth',
  'Gravy',
] as const

// Inspiration words for soul generation
const INSPIRATION = [
  'thunder', 'biscuit', 'void', 'accordion', 'moss', 'velvet', 'static',
  'marble', 'squall', 'prism', 'glyph', 'lichen', 'torque', 'ember', 'drift',
  'mercury', 'fable', 'plume', 'cipher', 'soot', 'quartz', 'anthem', 'gauge',
  'thistle', 'rumble', 'opal', 'forge', 'vex', 'wane', 'yew', 'zest',
] as const

function fallbackSoul(bones: CompanionBones): CompanionSoul {
  const idx = bones.species.charCodeAt(0) + bones.eye.charCodeAt(0)
  return {
    name: FALLBACK_NAMES[idx % FALLBACK_NAMES.length]!,
    personality: `A ${bones.rarity} ${bones.species} of few words.`,
  }
}

function hatchCompanion(
  setCompanionReaction: (reaction: string | undefined) => void,
): StoredCompanion {
  const userId = companionUserId()
  const { bones } = roll(userId)

  // Use fallback soul generation (API-based soul generation requires
  // firstParty org access to /api/organizations/{org}/claude_code/buddy_react)
  const soul = fallbackSoul(bones)
  const hatchedAt = Date.now()

  // Persist soul in global config
  saveGlobalConfig(config => ({
    ...config,
    companion: { ...soul, hatchedAt },
  }))

  return { ...soul, hatchedAt }
}

function StatBar({
  name,
  value,
}: {
  name: string
  value: number
}): React.ReactNode {
  const filled = Math.round(value / 10)
  const empty = 10 - filled
  return (
    <Text>
      <Text>{name.padEnd(10)}</Text>
      <Text color="green">{'█'.repeat(filled)}</Text>
      <Text dimColor>{'░'.repeat(empty)}</Text>
      <Text dimColor> {String(value).padStart(3)}</Text>
    </Text>
  )
}

function CompanionCard({
  bones,
  soul,
  lastReaction,
}: {
  bones: CompanionBones
  soul: CompanionSoul & { hatchedAt: number }
  lastReaction?: string
}): React.ReactNode {
  const [theme] = useTheme()
  const rarityColor =
    theme[RARITY_COLORS[bones.rarity]] ?? undefined

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={rarityColor}
      width={40}
      paddingX={1}
    >
      <Box justifyContent="center">
        <Text color={rarityColor}>
          {RARITY_STARS[bones.rarity]} {bones.rarity.toUpperCase()}
        </Text>
      </Box>
      <Box justifyContent="center">
        <Text bold>{bones.species.toUpperCase()}</Text>
      </Box>
      {bones.shiny && (
        <Box justifyContent="center">
          <Text>✨ SHINY ✨</Text>
        </Box>
      )}
      <Box justifyContent="center" marginY={1}>
        <Text color={rarityColor}>
          {renderSprite(bones, 0).join('\n')}
        </Text>
      </Box>
      <Box justifyContent="center">
        <Text bold>{soul.name}</Text>
      </Box>
      <Box justifyContent="center">
        <Text dimColor italic>
          {soul.personality}
        </Text>
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {STAT_NAMES.map(stat => (
          <StatBar key={stat} name={stat} value={bones.stats[stat]} />
        ))}
      </Box>
      {lastReaction && (
        <Box marginTop={1} justifyContent="center">
          <Text dimColor>&ldquo;{lastReaction}&rdquo;</Text>
        </Box>
      )}
    </Box>
  )
}

function HatchingView({
  bones,
  soul,
  onDone,
}: {
  bones: CompanionBones
  soul: CompanionSoul & { hatchedAt: number }
  onDone: (msg: string, opts?: { display?: string }) => void
}): React.ReactNode {
  return (
    <Box flexDirection="column" gap={1}>
      <CompanionCard bones={bones} soul={soul} />
      <Box flexDirection="column">
        <Text dimColor>
          {soul.name} is here · it&apos;ll chime in as you code
        </Text>
        <Text dimColor>
          your buddy won&apos;t count toward your usage
        </Text>
        <Text dimColor>
          say its name to get its take · /buddy pet · /buddy off
        </Text>
      </Box>
    </Box>
  )
}

export const call: LocalJSXCommandCall = async (onDone, context, args) => {
  const config = getGlobalConfig()
  const arg = args?.trim()

  if (arg === 'off') {
    if (config.companionMuted !== true) {
      saveGlobalConfig(c => ({ ...c, companionMuted: true }))
    }
    onDone('companion muted', { display: 'system' })
    return null
  }

  if (arg === 'on') {
    if (config.companionMuted === true) {
      saveGlobalConfig(c => ({ ...c, companionMuted: false }))
    }
    onDone('companion unmuted', { display: 'system' })
    return null
  }

  if (!isBuddyLive()) {
    onDone('buddy is unavailable on this configuration', {
      display: 'system',
    })
    return null
  }

  if (arg === 'pet') {
    const companion = getCompanion()
    if (!companion) {
      onDone('no companion yet · run /buddy first', { display: 'system' })
      return null
    }
    if (config.companionMuted === true) {
      saveGlobalConfig(c => ({ ...c, companionMuted: false }))
    }
    context.setAppState((s: any) => ({ ...s, companionPetAt: Date.now() }))
    onDone(`petted ${companion.name}`, { display: 'system' })
    return null
  }

  // Unmute if muted
  if (config.companionMuted === true) {
    saveGlobalConfig(c => ({ ...c, companionMuted: false }))
  }

  // Show existing companion
  const existing = getCompanion()
  if (existing) {
    return (
      <CompanionCard
        bones={existing}
        soul={{
          name: existing.name,
          personality: existing.personality,
          hatchedAt: existing.hatchedAt,
        }}
      />
    )
  }

  // Hatch new companion
  const setReaction = (reaction: string | undefined) => {
    context.setAppState((s: any) => ({ ...s, companionReaction: reaction }))
  }
  const soul = hatchCompanion(setReaction)
  const { bones } = roll(companionUserId())

  return <HatchingView bones={bones} soul={soul} onDone={onDone} />
}
