import { Badge, BadgeProps, Tooltip } from '@mui/material'
import { UserStatusType } from 'data'
import VideogameAssetIcon from '@mui/icons-material/VideogameAsset'

const getData = (
  status: UserStatusType,
): Partial<BadgeProps> & Record<'tooltip', string> => {
  switch (status) {
    case 'ONLINE':
      return { tooltip: 'Online', color: 'success', badgeContent: ' ' }
    case 'OFFLINE':
      return { tooltip: 'Offline', color: 'error', badgeContent: ' ' }
    case 'GAME':
      return {
        tooltip: `Playing game`,
        color: 'primary',
        badgeContent: <VideogameAssetIcon />,
      }
    case 'UNKNOWN':
      return { tooltip: 'Unknown', color: 'warning', badgeContent: '?' }
  }
}
interface UserStatusProps {
  status: UserStatusType
  avatar?: JSX.Element
  big?: boolean
}
/** TODO: make size configurable */
export const UserStatus = ({
  status,
  avatar,
  big = false,
}: UserStatusProps) => {
  const { color, badgeContent, tooltip } = getData(status)

  return (
    <Tooltip title={tooltip} placement="right-end">
      <Badge
        color={color}
        badgeContent={badgeContent}
        overlap="circular"
        variant={big ? 'standard' : 'dot'}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        {avatar}
      </Badge>
    </Tooltip>
  )
}
